import { test, expect, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import {
    INLINE_MEDIA_MAX_BYTES,
    configureMedia,
    sanitizeId,
    mediaPaths,
    writeMedia,
    readMedia,
    deleteMedia,
    clearUserMedia,
    mediaExists,
    mediaDiskBytes,
    mediaTtlMs,
    maxDocumentBytes,
    maxDiskBytes,
    maxUserBytes,
    userDirBytes,
    enforceUserCap,
    downloadPolicy,
    sweepExpired,
    resolveMediaForMessage,
    verifyMediaToken,
    mediaGetResponse,
    mediaDeleteResponse,
    resetMediaState
} from './media';

const root = mkdtempSync(join(tmpdir(), 'wa-media-'));
let mediaRoot: string;
let caseId = 0;

const ENV_KEYS = ['WHATSAPP_MEDIA_TTL_MS', 'WHATSAPP_MEDIA_MAX_BYTES', 'WHATSAPP_MEDIA_MAX_DISK_BYTES', 'WHATSAPP_MEDIA_MAX_USER_BYTES'];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
    mediaRoot = join(root, `media-${caseId++}`);
    configureMedia(() => mediaRoot);
    resetMediaState();
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const USER = '42';
const MSG_ID = 'true_919999000001@c.us_ABC';

function bytes(text: string) {
    return new TextEncoder().encode(text);
}

// ── sanitizeId ──

test('sanitizeId passes real ids through and strips hostile characters', () => {
    expect(sanitizeId(MSG_ID)).toBe(MSG_ID);
    expect(sanitizeId('42')).toBe('42');
    expect(sanitizeId('a/b\\c d#e?f')).toBe('abcdef');     // path + query chars stripped
    expect(sanitizeId('../../etc/passwd')).toBe('....etcpasswd'); // traversal neutered
});

test('sanitizeId rejects empty, dot-only, oversized and non-string ids', () => {
    expect(sanitizeId('')).toBeNull();
    expect(sanitizeId('///')).toBeNull();        // strips to empty
    expect(sanitizeId('.')).toBeNull();
    expect(sanitizeId('..')).toBeNull();
    expect(sanitizeId('...')).toBeNull();
    expect(sanitizeId('x'.repeat(201))).toBeNull();
    expect(sanitizeId(null)).toBeNull();
    expect(sanitizeId(undefined)).toBeNull();
    expect(sanitizeId(42 as any)).toBeNull();
});

// ── mediaPaths ──

test('mediaPaths lays files out under <root>/<user>/<messageId> and never escapes the root', () => {
    const paths = mediaPaths(USER, MSG_ID)!;
    expect(paths.dir).toBe(resolve(mediaRoot, USER));
    expect(paths.dataPath).toBe(resolve(mediaRoot, USER, MSG_ID));
    // '~' is outside the sanitize charset, so no message id can ever name a sidecar.
    expect(paths.metaPath).toBe(`${paths.dataPath}~meta.json`);
    expect(paths.dataPath.startsWith(resolve(mediaRoot) + sep)).toBe(true);

    const hostile = mediaPaths('../../outside', '../../../etc/passwd')!;
    expect(hostile.dataPath.startsWith(resolve(mediaRoot) + sep)).toBe(true);
});

// Regression: a sanitized message id ending in ".json" used to land in the
// sidecar namespace — skipped by accounting, deletable as an orphan, and able
// to overwrite another message's sidecar.
test('a message id ending in .json cannot collide with a sidecar', () => {
    writeMedia(USER, 'm1', bytes('real-payload'), { mime: 'image/png' });
    // Hostile/unlucky id: exactly the OLD sidecar name of message m1.
    writeMedia(USER, 'm1.json', bytes('12345'), { mime: 'application/json' });

    // m1's sidecar survives intact — the second write touched different files.
    expect(mediaExists(USER, 'm1')!.mime).toBe('image/png');
    expect(mediaExists(USER, 'm1.json')!.size).toBe(5);

    // Accounting counts BOTH payloads (the .json one is data, not a sidecar).
    expect(mediaDiskBytes()).toBe(17);

    // The sweep treats it as data too: fresh → kept, not reaped as an orphan.
    expect(sweepExpired()).toBe(0);
    expect(mediaExists(USER, 'm1.json')).not.toBeNull();
    expect(mediaDiskBytes()).toBe(17);

    // And deleting one message never touches the other's files.
    expect(deleteMedia(USER, 'm1')).toBe(true);
    expect(mediaExists(USER, 'm1')).toBeNull();
    expect(readMedia(USER, 'm1.json')!.data.toString()).toBe('12345');
});

test('mediaPaths returns null when either id fails sanitization', () => {
    expect(mediaPaths('..', MSG_ID)).toBeNull();
    expect(mediaPaths(USER, '//')).toBeNull();
});

// ── write / read / delete / exists ──

test('writeMedia + mediaExists + readMedia roundtrip bytes and sidecar metadata', () => {
    const data = bytes('jpeg-bytes');
    expect(writeMedia(USER, MSG_ID, data, { mime: 'image/jpeg', filename: 'beach.jpg' })).toBe(true);

    const meta = mediaExists(USER, MSG_ID)!;
    expect(meta.mime).toBe('image/jpeg');
    expect(meta.filename).toBe('beach.jpg');
    expect(meta.size).toBe(data.byteLength);
    expect(meta.capturedAt).toBeGreaterThan(0);

    const found = readMedia(USER, MSG_ID)!;
    expect(new Uint8Array(found.data)).toEqual(data);
    expect(found.meta.mime).toBe('image/jpeg');

    // Sidecar is real JSON on disk next to the payload.
    const sidecar = JSON.parse(readFileSync(mediaPaths(USER, MSG_ID)!.metaPath, 'utf8'));
    expect(sidecar.size).toBe(data.byteLength);
});

test('writeMedia stores a null filename and refuses invalid ids and fs failures', () => {
    expect(writeMedia(USER, MSG_ID, bytes('x'), { mime: 'audio/ogg' })).toBe(true);
    expect(mediaExists(USER, MSG_ID)!.filename).toBeNull();

    expect(writeMedia('..', MSG_ID, bytes('x'), { mime: 'audio/ogg' })).toBe(false);

    // A FILE squatting on the user dir path makes mkdir/write explode → false.
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(join(mediaRoot, 'blocked'), 'not-a-dir');
    expect(writeMedia('blocked', MSG_ID, bytes('x'), { mime: 'image/png' })).toBe(false);
});

test('mediaExists is null for missing pairs, half-written pairs and corrupt sidecars', () => {
    expect(mediaExists(USER, 'never-written')).toBeNull();
    expect(mediaExists('..', MSG_ID)).toBeNull();

    const paths = mediaPaths(USER, MSG_ID)!;
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.dataPath, 'payload-without-sidecar');
    expect(mediaExists(USER, MSG_ID)).toBeNull();

    writeFileSync(paths.metaPath, 'not json');
    expect(mediaExists(USER, MSG_ID)).toBeNull();
});

test('mediaExists tolerates a sidecar with junk field types', () => {
    const paths = mediaPaths(USER, MSG_ID)!;
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.dataPath, 'x');
    writeFileSync(paths.metaPath, JSON.stringify({ mime: 5, filename: 7, size: 'big', capturedAt: 'now' }));

    const meta = mediaExists(USER, MSG_ID)!;
    expect(meta.mime).toBe('application/octet-stream');
    expect(meta.filename).toBeNull();
    expect(meta.size).toBe(0);
    expect(meta.capturedAt).toBe(0);
});

test('readMedia is null when the payload vanished after the sidecar check', () => {
    writeMedia(USER, MSG_ID, bytes('x'), { mime: 'image/png' });
    rmSync(mediaPaths(USER, MSG_ID)!.dataPath);
    // Sidecar alone → mediaExists already says no.
    expect(readMedia(USER, MSG_ID)).toBeNull();
});

test('deleteMedia removes the pair, is idempotent, and rejects invalid ids', () => {
    writeMedia(USER, MSG_ID, bytes('x'), { mime: 'image/png' });
    expect(deleteMedia(USER, MSG_ID)).toBe(true);
    expect(mediaExists(USER, MSG_ID)).toBeNull();
    expect(existsSync(mediaPaths(USER, MSG_ID)!.dataPath)).toBe(false);

    expect(deleteMedia(USER, MSG_ID)).toBe(true); // second delete: still fine
    expect(deleteMedia('..', MSG_ID)).toBe(false);
});

// ── clearUserMedia (logout privacy contract) ──

test('clearUserMedia removes every file for the user and fixes the accounting', () => {
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });
    writeMedia(USER, 'm2', bytes('1234567890'), { mime: 'application/pdf', filename: 'doc.pdf' });
    writeMedia('7', 'other', bytes('123'), { mime: 'image/png' });
    expect(mediaDiskBytes()).toBe(18);

    expect(clearUserMedia(USER)).toBe(true);

    expect(mediaExists(USER, 'm1')).toBeNull();
    expect(mediaExists(USER, 'm2')).toBeNull();
    expect(existsSync(join(mediaRoot, USER))).toBe(false);   // dir itself gone
    expect(mediaExists('7', 'other')).not.toBeNull();        // scoped per user
    expect(mediaDiskBytes()).toBe(3);                        // cap accounting refreshed
});

test('clearUserMedia is idempotent and safe before any media was stored', () => {
    expect(clearUserMedia(USER)).toBe(true);                 // nothing on disk yet
    writeMedia(USER, 'm1', bytes('x'), { mime: 'image/png' });
    expect(clearUserMedia(USER)).toBe(true);
    expect(clearUserMedia(USER)).toBe(true);                 // repeat is fine
});

test('clearUserMedia refuses traversal-hostile user ids without touching the root', () => {
    writeMedia(USER, 'm1', bytes('payload'), { mime: 'image/png' });

    expect(clearUserMedia('..')).toBe(false);
    expect(clearUserMedia('../..')).toBe(false);
    expect(clearUserMedia('')).toBe(false);
    expect(clearUserMedia(null as any)).toBe(false);

    expect(mediaExists(USER, 'm1')).not.toBeNull();          // nothing collateral
    expect(existsSync(mediaRoot)).toBe(true);                // root untouched
});

// ── disk accounting ──

test('mediaDiskBytes counts payload bytes only and tracks writes and deletes', () => {
    expect(mediaDiskBytes()).toBe(0);
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });
    writeMedia('7', 'm2', bytes('1234567890'), { mime: 'image/png' });
    expect(mediaDiskBytes()).toBe(15); // sidecar JSON not counted

    deleteMedia(USER, 'm1');
    expect(mediaDiskBytes()).toBe(10);

    // Fresh process (cache reset) recomputes the same truth from disk.
    resetMediaState();
    expect(mediaDiskBytes()).toBe(10);
});

// ── downloadPolicy ──

test('downloadPolicy allows image/audio/ptt up to 16MB and rejects above', () => {
    for (const type of ['image', 'audio', 'ptt']) {
        expect(downloadPolicy(type, INLINE_MEDIA_MAX_BYTES)).toEqual({ download: true });
        expect(downloadPolicy(type, INLINE_MEDIA_MAX_BYTES + 1)).toEqual({ download: false, reason: 'too_large' });
    }
});

test('downloadPolicy caps documents at WHATSAPP_MEDIA_MAX_BYTES (default 25MB)', () => {
    expect(maxDocumentBytes()).toBe(25 * 1024 * 1024);
    expect(downloadPolicy('document', 25 * 1024 * 1024)).toEqual({ download: true });
    expect(downloadPolicy('document', 25 * 1024 * 1024 + 1)).toEqual({ download: false, reason: 'too_large' });

    process.env.WHATSAPP_MEDIA_MAX_BYTES = '10';
    expect(downloadPolicy('document', 10)).toEqual({ download: true });
    expect(downloadPolicy('document', 11)).toEqual({ download: false, reason: 'too_large' });
});

test('downloadPolicy skips stickers, videos, unknown types and view-once media', () => {
    expect(downloadPolicy('sticker', 10)).toEqual({ download: false, reason: 'unsupported_type' });
    expect(downloadPolicy('video', 10)).toEqual({ download: false, reason: 'unsupported_type' });
    expect(downloadPolicy('chat', 10)).toEqual({ download: false, reason: 'unsupported_type' });
    expect(downloadPolicy('image', 10, true)).toEqual({ download: false, reason: 'unsupported_type' });
});

// Malformed env → NaN → every comparison false → sweep + cap silently off.
test('malformed limit envs fall back to the defaults instead of NaN', () => {
    process.env.WHATSAPP_MEDIA_TTL_MS = '2 days';
    process.env.WHATSAPP_MEDIA_MAX_BYTES = 'garbage';
    process.env.WHATSAPP_MEDIA_MAX_DISK_BYTES = '50GB';
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '1 gig';

    expect(mediaTtlMs()).toBe(48 * 60 * 60 * 1000);
    expect(maxDocumentBytes()).toBe(25 * 1024 * 1024);
    expect(maxDiskBytes()).toBe(5 * 1024 * 1024 * 1024);
    expect(maxUserBytes()).toBe(1024 * 1024 * 1024);

    // The guards stay live: the document cap still rejects oversize media...
    expect(downloadPolicy('document', 25 * 1024 * 1024 + 1))
        .toEqual({ download: false, reason: 'too_large' });

    // ...and the TTL sweep still evicts media older than the default 48h.
    writeMedia(USER, 'old', bytes('x'), { mime: 'image/png' });
    expect(sweepExpired(Date.now() + 48 * 60 * 60 * 1000 + 1000)).toBe(1);
});

// The per-user cap is now enforced post-write by eviction, so downloadPolicy
// NEVER skips a download on disk grounds — a user is never starved. Even with
// a tiny disk cap and a near-full disk, the policy still says download (the
// post-write enforceUserCap rolls the oldest off instead).
test('downloadPolicy never refuses on disk grounds (per-user eviction replaces starvation)', () => {
    process.env.WHATSAPP_MEDIA_MAX_DISK_BYTES = '12';
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    writeMedia(USER, 'taken', bytes('1234567890'), { mime: 'image/png' }); // 10 bytes used

    expect(downloadPolicy('image', 2)).toEqual({ download: true });
    expect(downloadPolicy('image', 3)).toEqual({ download: true });  // would-blow-disk still allowed
    expect(downloadPolicy('image', INLINE_MEDIA_MAX_BYTES)).toEqual({ download: true }); // up to the per-message cap

    // ...but the per-MESSAGE size gate still rejects oversize media.
    expect(downloadPolicy('image', INLINE_MEDIA_MAX_BYTES + 1)).toEqual({ download: false, reason: 'too_large' });
});

// ── maxUserBytes / userDirBytes / enforceUserCap (per-user rolling cap) ──

// Backdate a stored item's capturedAt so the oldest-first eviction order is
// deterministic regardless of write timing (sub-ms writes share a clock).
function backdate(userId: string, messageId: string, capturedAt: number) {
    const p = mediaPaths(userId, messageId)!;
    const sidecar = JSON.parse(readFileSync(p.metaPath, 'utf8'));
    sidecar.capturedAt = capturedAt;
    writeFileSync(p.metaPath, JSON.stringify(sidecar));
}

test('maxUserBytes defaults to 1GB', () => {
    expect(maxUserBytes()).toBe(1024 * 1024 * 1024);
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '2048';
    expect(maxUserBytes()).toBe(2048);
});

test('userDirBytes counts only that user payloads, sidecars excluded', () => {
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });
    writeMedia(USER, 'm2', bytes('1234567890'), { mime: 'image/png' });
    writeMedia('7', 'other', bytes('123'), { mime: 'image/png' });

    expect(userDirBytes(USER)).toBe(15);   // 5 + 10, sidecar JSON not counted
    expect(userDirBytes('7')).toBe(3);     // scoped per user
    expect(userDirBytes('never')).toBe(0); // no dir yet
    expect(userDirBytes('..')).toBe(0);    // unsanitizable id
});

// Writing past 1GB (here: a tiny cap) evicts THAT user's OLDEST media, oldest
// first, until they fit — the new media survives. Stored under a generous cap
// and backdated to fix the age order, then enforced under the tight cap so the
// eviction is deterministic (not at the mercy of the inline write hook).
test('writing past the user cap evicts the user oldest media first', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '1000'; // generous: no inline eviction
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' }); backdate(USER, 'm1', 1); // 5
    writeMedia(USER, 'm2', bytes('12345'), { mime: 'image/png' }); backdate(USER, 'm2', 2); // 5
    writeMedia(USER, 'm3', bytes('12345'), { mime: 'image/png' }); backdate(USER, 'm3', 3); // 5
    expect(mediaDiskBytes()).toBe(15);

    // Tighten to 12 and enforce: 15 > 12 → evict the oldest (m1, 5) → 10 ≤ 12.
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    expect(enforceUserCap(USER)).toBe(1);

    expect(mediaExists(USER, 'm1')).toBeNull();        // oldest gone
    expect(mediaExists(USER, 'm2')).not.toBeNull();
    expect(mediaExists(USER, 'm3')).not.toBeNull();
    expect(userDirBytes(USER)).toBe(10);
    expect(mediaDiskBytes()).toBe(10);                 // global total kept honest
});

test('enforceUserCap evicts multiple oldest items when the dir blows well past the cap', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '1000'; // generous during the writes
    writeMedia(USER, 'a', bytes('111'), { mime: 'image/png' }); backdate(USER, 'a', 1); // 3
    writeMedia(USER, 'b', bytes('222'), { mime: 'image/png' }); backdate(USER, 'b', 2); // 3
    writeMedia(USER, 'c', bytes('3333333333'), { mime: 'image/png' }); backdate(USER, 'c', 3); // 10

    // 16 bytes, cap 6 → evict a (3) → 13, evict b (3) → 10, evict c (10) → 0.
    // Even the single 10-byte file exceeds the cap, so the loop empties the dir.
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '6';
    expect(enforceUserCap(USER)).toBe(3);
    expect(userDirBytes(USER)).toBe(0);
    expect(mediaDiskBytes()).toBe(0);
});

test('enforceUserCap evicts one user without touching another (independent caps)', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '1000'; // generous during the writes
    writeMedia(USER, 'a', bytes('111'), { mime: 'image/png' }); backdate(USER, 'a', 1); // 3
    writeMedia(USER, 'b', bytes('222'), { mime: 'image/png' }); backdate(USER, 'b', 2); // 3
    writeMedia('7', 'x', bytes('12345'), { mime: 'image/png' }); backdate('7', 'x', 1); // 5
    writeMedia('7', 'y', bytes('12345'), { mime: 'image/png' }); backdate('7', 'y', 2); // +5 = 10

    // Cap 6: USER (6 bytes) is exactly at the cap → no eviction; user 7 (10) is over.
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '6';
    expect(enforceUserCap(USER)).toBe(0);
    expect(mediaExists(USER, 'a')).not.toBeNull();
    expect(mediaExists(USER, 'b')).not.toBeNull();

    // User 7 over cap evicts only user 7 oldest; USER untouched.
    expect(enforceUserCap('7')).toBe(1);
    expect(mediaExists('7', 'x')).toBeNull();     // user 7 oldest gone
    expect(mediaExists('7', 'y')).not.toBeNull();
    expect(userDirBytes(USER)).toBe(6);           // the other user is intact
});

test('enforceUserCap is a no-op for a user under the cap, an empty dir and bad ids', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '100';
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });

    expect(enforceUserCap(USER)).toBe(0);         // under cap
    expect(mediaExists(USER, 'm1')).not.toBeNull();
    expect(enforceUserCap('never-stored')).toBe(0); // no dir
    expect(enforceUserCap('..')).toBe(0);           // unsanitizable id
});

// NaN cap → enforceUserCap must still use the 1GB default, never treat NaN as
// "0, evict everything" or "Infinity, never evict via a broken comparison".
test('enforceUserCap falls back to the 1GB default on a malformed cap env', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = 'one gigabyte';
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });

    expect(maxUserBytes()).toBe(1024 * 1024 * 1024);
    expect(enforceUserCap(USER)).toBe(0);         // 5 bytes ≪ 1GB → nothing evicted
    expect(mediaExists(USER, 'm1')).not.toBeNull();
});

// The post-write hook: writeMedia itself enforces the cap, so a caller that
// just writes (no explicit enforceUserCap) still rolls the oldest off. Here
// capturedAt ties on the shared clock, so the eviction falls back to file
// mtime ordering — the regression that proves the mtime path works.
test('writeMedia enforces the cap inline, falling back to mtime order on a clock tie', () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    const first = mediaPaths(USER, 'm1')!;
    writeMedia(USER, 'm1', bytes('12345'), { mime: 'image/png' });
    // Make m1 unambiguously older by mtime AND drop its sidecar capturedAt so
    // the age source falls back to mtime.
    const sidecar = JSON.parse(readFileSync(first.metaPath, 'utf8'));
    delete sidecar.capturedAt;
    writeFileSync(first.metaPath, JSON.stringify(sidecar));
    const past = (Date.now() - 60000) / 1000;
    utimesSync(first.dataPath, past, past);

    writeMedia(USER, 'm2', bytes('12345'), { mime: 'image/png' }); // 10 ≤ 12 → no eviction
    writeMedia(USER, 'm3', bytes('12345'), { mime: 'image/png' }); // 15 > 12 → evict oldest (m1)

    expect(mediaExists(USER, 'm1')).toBeNull();
    expect(mediaExists(USER, 'm2')).not.toBeNull();
    expect(mediaExists(USER, 'm3')).not.toBeNull();
    expect(userDirBytes(USER)).toBe(10);
});

// ── sweepExpired ──

test('sweepExpired removes media past the TTL, keeps fresh media, refreshes the cap total', () => {
    expect(mediaTtlMs()).toBe(48 * 60 * 60 * 1000);
    writeMedia(USER, 'old', bytes('old-bytes'), { mime: 'image/png' });
    writeMedia(USER, 'fresh', bytes('fresh'), { mime: 'image/png' });

    // Backdate the sidecar's capturedAt beyond the TTL.
    const oldPaths = mediaPaths(USER, 'old')!;
    const sidecar = JSON.parse(readFileSync(oldPaths.metaPath, 'utf8'));
    sidecar.capturedAt = Date.now() - mediaTtlMs() - 1000;
    writeFileSync(oldPaths.metaPath, JSON.stringify(sidecar));

    expect(sweepExpired()).toBe(1);
    expect(mediaExists(USER, 'old')).toBeNull();
    expect(existsSync(oldPaths.metaPath)).toBe(false);
    expect(mediaExists(USER, 'fresh')).not.toBeNull();
    expect(mediaDiskBytes()).toBe(5); // 'fresh' only
});

test('sweepExpired honours the WHATSAPP_MEDIA_TTL_MS override', () => {
    writeMedia(USER, 'm1', bytes('x'), { mime: 'image/png' });
    process.env.WHATSAPP_MEDIA_TTL_MS = '50';
    expect(sweepExpired(Date.now() + 200)).toBe(1);
});

test('sweepExpired falls back to file mtime for payloads with no sidecar', () => {
    const paths = mediaPaths(USER, 'orphan')!;
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.dataPath, 'orphan-bytes');
    const past = (Date.now() - mediaTtlMs() - 60000) / 1000;
    utimesSync(paths.dataPath, past, past);

    expect(sweepExpired()).toBe(1);
    expect(existsSync(paths.dataPath)).toBe(false);
});

test('sweepExpired removes orphaned sidecars and survives a missing media root', () => {
    const paths = mediaPaths(USER, 'gone')!;
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.metaPath, JSON.stringify({ mime: 'image/png', size: 1, capturedAt: Date.now() }));

    expect(sweepExpired()).toBe(0); // orphans don't count as expired media
    expect(existsSync(paths.metaPath)).toBe(false);

    configureMedia(() => join(root, 'never-created'));
    expect(sweepExpired()).toBe(0);
});

// ── resolveMediaForMessage ──

function mediaMsg(overrides: any = {}, dataOverrides: any = {}) {
    return {
        from: '919999000001@c.us',
        id: { _serialized: MSG_ID },
        timestamp: 1717000000,
        type: 'image',
        hasMedia: true,
        _data: { size: 1024, mimetype: 'image/jpeg', ...dataOverrides },
        downloadMedia: async () => ({
            data: Buffer.from('jpeg-bytes').toString('base64'),
            mimetype: 'image/jpeg',
            filename: 'beach.jpg'
        }),
        ...overrides
    };
}

test('resolveMediaForMessage downloads, persists and reports an available verdict', async () => {
    const verdict = await resolveMediaForMessage(USER, mediaMsg());

    expect(verdict).toEqual({
        mediaStatus: 'available',
        mediaMime: 'image/jpeg',
        mediaFilename: 'beach.jpg',
        mediaSize: 10
    });
    const stored = readMedia(USER, MSG_ID)!;
    expect(stored.data.toString()).toBe('jpeg-bytes');
});

test('resolveMediaForMessage short-circuits when the media is already on disk (backfill)', async () => {
    writeMedia(USER, MSG_ID, bytes('cached'), { mime: 'image/png', filename: 'c.png' });

    let downloads = 0;
    const msg = mediaMsg({ downloadMedia: async () => { downloads += 1; return null; } });
    const verdict = await resolveMediaForMessage(USER, msg);

    expect(downloads).toBe(0);
    expect(verdict).toEqual({
        mediaStatus: 'available', mediaMime: 'image/png', mediaFilename: 'c.png', mediaSize: 6
    });
});

test('resolveMediaForMessage skips unsupported types and view-once without downloading', async () => {
    let downloads = 0;
    const dl = async () => { downloads += 1; return null; };

    expect(await resolveMediaForMessage(USER, mediaMsg({ type: 'video', downloadMedia: dl })))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'unsupported_type' });
    expect(await resolveMediaForMessage(USER, mediaMsg({ downloadMedia: dl }, { isViewOnce: true })))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'unsupported_type' });
    expect(downloads).toBe(0);
});

test('resolveMediaForMessage rejects on the declared size before downloading', async () => {
    const msg = mediaMsg({}, { size: INLINE_MEDIA_MAX_BYTES + 1 });
    expect(await resolveMediaForMessage(USER, msg))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'too_large' });
});

test('resolveMediaForMessage re-checks the real byte size after download', async () => {
    process.env.WHATSAPP_MEDIA_MAX_BYTES = '5';
    // Declared size lies (says 3), actual payload is 10 bytes.
    const msg = mediaMsg({ type: 'document' }, { size: 3, mimetype: 'application/pdf' });
    expect(await resolveMediaForMessage(USER, msg))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'too_large' });
    expect(mediaExists(USER, MSG_ID)).toBeNull();
});

// The download always succeeds now; the per-user cap is honoured AFTER the
// write by evicting the user's oldest, so the new media is always available.
test('resolveMediaForMessage stores the new media and evicts the oldest under the cap', async () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    // An older payload (backdated so it is unambiguously the oldest).
    writeMedia(USER, 'oldest', bytes('12345678'), { mime: 'image/png' }); // 8 used
    const oldPaths = mediaPaths(USER, 'oldest')!;
    const sidecar = JSON.parse(readFileSync(oldPaths.metaPath, 'utf8'));
    sidecar.capturedAt = 1; // ancient
    writeFileSync(oldPaths.metaPath, JSON.stringify(sidecar));

    // 10 real bytes arrive → 18 > 12 → the oldest (8) is rolled off, leaving 10.
    const msg = mediaMsg({}, { size: undefined });
    expect(await resolveMediaForMessage(USER, msg))
        .toEqual({ mediaStatus: 'available', mediaMime: 'image/jpeg', mediaFilename: 'beach.jpg', mediaSize: 10 });
    expect(mediaExists(USER, MSG_ID)).not.toBeNull();   // new media kept
    expect(mediaExists(USER, 'oldest')).toBeNull();     // oldest evicted
    expect(mediaDiskBytes()).toBe(10);
});

test('resolveMediaForMessage maps undefined download results to expired', async () => {
    const noMedia = mediaMsg({ downloadMedia: async () => undefined });
    expect(await resolveMediaForMessage(USER, noMedia))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'expired' });

    const dataless = mediaMsg({ downloadMedia: async () => ({ mimetype: 'image/jpeg' }) });
    expect(await resolveMediaForMessage(USER, dataless))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'expired' });
});

test('resolveMediaForMessage maps a throwing or hanging download to download_failed', async () => {
    const throwing = mediaMsg({ downloadMedia: async () => { throw new Error('boom'); } });
    expect(await resolveMediaForMessage(USER, throwing))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'download_failed' });

    const syncThrow = mediaMsg({ downloadMedia: () => { throw new Error('sync boom'); } });
    expect(await resolveMediaForMessage(USER, syncThrow))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'download_failed' });

    const hanging = mediaMsg({ downloadMedia: () => new Promise(() => {}) });
    expect(await resolveMediaForMessage(USER, hanging, { timeoutMs: 20 }))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'download_failed' });
});

test('resolveMediaForMessage reports invalid_id for unsanitizable ids', async () => {
    expect(await resolveMediaForMessage('..', mediaMsg()))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'invalid_id' });
    expect(await resolveMediaForMessage(USER, mediaMsg({ id: { _serialized: '//' } })))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'invalid_id' });
});

test('resolveMediaForMessage falls back to the from-timestamp message id', async () => {
    const msg = mediaMsg({ id: undefined });
    const verdict = await resolveMediaForMessage(USER, msg);
    expect(verdict.mediaStatus).toBe('available');
    // Same fallback normalizeInbound uses → host can address the file.
    expect(mediaExists(USER, '919999000001@c.us-1717000000')).not.toBeNull();
});

// The fallback must mirror normalizeInbound's COUNTERPARTY keying: on fromMe
// the `from` is the operator's own jid, shared by every chat — keying on it
// stores the bytes under an id the wire never advertised (host GET 404s) and
// collides two same-second sends to different customers on the same path.
test('resolveMediaForMessage keys the fromMe fallback id on the counterparty', async () => {
    const msg = mediaMsg({ id: undefined, fromMe: true, from: '919000000001@c.us', to: '919999000002@c.us' });
    const verdict = await resolveMediaForMessage(USER, msg);
    expect(verdict.mediaStatus).toBe('available');
    expect(mediaExists(USER, '919999000002@c.us-1717000000')).not.toBeNull();   // keyed on `to`…
    expect(mediaExists(USER, '919000000001@c.us-1717000000')).toBeNull();       // …never the operator
});

test('resolveMediaForMessage fills mime/filename gaps and omits a missing filename', async () => {
    const msg = mediaMsg(
        { downloadMedia: async () => ({ data: Buffer.from('x').toString('base64') }) },
        { mimetype: 'image/webp' }
    );
    const verdict = await resolveMediaForMessage(USER, msg);

    expect(verdict.mediaMime).toBe('image/webp');       // from _data when payload lacks it
    expect(verdict.mediaSize).toBe(1);
    expect('mediaFilename' in verdict).toBe(false);     // no filename anywhere → omitted

    const bare = mediaMsg({
        id: { _serialized: 'bare-1' },
        downloadMedia: async () => ({ data: Buffer.from('y').toString('base64') }),
        _data: undefined
    });
    expect((await resolveMediaForMessage(USER, bare)).mediaMime).toBe('application/octet-stream');
});

test('resolveMediaForMessage reports download_failed when persisting fails', async () => {
    // A FILE squatting on the user dir path makes writeMedia fail.
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(join(mediaRoot, 'squat'), 'not-a-dir');

    expect(await resolveMediaForMessage('squat', mediaMsg()))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'download_failed' });
});

// ── verifyMediaToken ──

test('verifyMediaToken enforces only when the service has a token configured', () => {
    expect(verifyMediaToken(undefined, undefined)).toBe(true);   // unset → open
    expect(verifyMediaToken('anything', undefined)).toBe(true);
    expect(verifyMediaToken('secret', 'secret')).toBe(true);
    expect(verifyMediaToken('wrong', 'secret')).toBe(false);
    expect(verifyMediaToken(undefined, 'secret')).toBe(false);   // missing header
    expect(verifyMediaToken('', 'secret')).toBe(false);
});

// ── GET /media route contract ──

test('mediaGetResponse serves raw bytes with mime, length and disposition headers', async () => {
    writeMedia(USER, MSG_ID, bytes('jpeg-bytes'), { mime: 'image/jpeg', filename: 'beach.jpg' });

    const res = mediaGetResponse(USER, MSG_ID, undefined, undefined);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Content-Length')).toBe('10');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="beach.jpg"');
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('jpeg-bytes');
});

test('mediaGetResponse sanitizes hostile filenames and handles missing ones', async () => {
    writeMedia(USER, 'm1', bytes('x'), { mime: 'application/pdf', filename: 'a"b\r\nSet-Cookie: x.pdf' });
    const evil = mediaGetResponse(USER, 'm1', undefined, undefined);
    expect(evil.headers.get('Content-Disposition')).toBe('attachment; filename="a_b__Set-Cookie_ x.pdf"');

    writeMedia(USER, 'm2', bytes('y'), { mime: 'audio/ogg' });
    const bare = mediaGetResponse(USER, 'm2', undefined, undefined);
    expect(bare.headers.get('Content-Disposition')).toBe('attachment');
});

test('mediaGetResponse answers the same 404 for unknown, swept and invalid ids', async () => {
    const missing = mediaGetResponse(USER, 'never-stored', undefined, undefined);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });

    const invalid = mediaGetResponse('..', '..', undefined, undefined);
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual({ error: 'not_found' });
});

test('mediaGetResponse rejects a bad token before touching the store', async () => {
    writeMedia(USER, MSG_ID, bytes('secret-bytes'), { mime: 'image/jpeg' });

    const res = mediaGetResponse(USER, MSG_ID, 'wrong', 'expected');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });

    expect(mediaGetResponse(USER, MSG_ID, 'expected', 'expected').status).toBe(200);
});

// ── DELETE /media route contract ──

test('mediaDeleteResponse deletes the pair and stays successful on repeats', async () => {
    writeMedia(USER, MSG_ID, bytes('x'), { mime: 'image/jpeg' });

    const first = mediaDeleteResponse(USER, MSG_ID, undefined, undefined);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ success: true });
    expect(mediaExists(USER, MSG_ID)).toBeNull();

    const again = mediaDeleteResponse(USER, MSG_ID, undefined, undefined);
    expect(await again.json()).toEqual({ success: true }); // idempotent

    const never = mediaDeleteResponse(USER, 'never-stored', undefined, undefined);
    expect(await never.json()).toEqual({ success: true });
});

test('mediaDeleteResponse enforces the token when configured', async () => {
    writeMedia(USER, MSG_ID, bytes('x'), { mime: 'image/jpeg' });

    const denied = mediaDeleteResponse(USER, MSG_ID, undefined, 'expected');
    expect(denied.status).toBe(401);
    expect(mediaExists(USER, MSG_ID)).not.toBeNull(); // nothing deleted

    expect(mediaDeleteResponse(USER, MSG_ID, 'expected', 'expected').status).toBe(200);
    expect(mediaExists(USER, MSG_ID)).toBeNull();
});
