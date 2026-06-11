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

const ENV_KEYS = ['WHATSAPP_MEDIA_TTL_MS', 'WHATSAPP_MEDIA_MAX_BYTES', 'WHATSAPP_MEDIA_MAX_DISK_BYTES'];
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
    expect(paths.metaPath).toBe(`${paths.dataPath}.json`);
    expect(paths.dataPath.startsWith(resolve(mediaRoot) + sep)).toBe(true);

    const hostile = mediaPaths('../../outside', '../../../etc/passwd')!;
    expect(hostile.dataPath.startsWith(resolve(mediaRoot) + sep)).toBe(true);
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

test('downloadPolicy refuses a download that would blow the disk cap', () => {
    expect(maxDiskBytes()).toBe(5 * 1024 * 1024 * 1024);
    process.env.WHATSAPP_MEDIA_MAX_DISK_BYTES = '12';
    writeMedia(USER, 'taken', bytes('1234567890'), { mime: 'image/png' }); // 10 bytes used

    expect(downloadPolicy('image', 2)).toEqual({ download: true });
    expect(downloadPolicy('image', 3)).toEqual({ download: false, reason: 'disk_full' });
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

test('resolveMediaForMessage reports disk_full when the actual bytes blow the cap', async () => {
    process.env.WHATSAPP_MEDIA_MAX_DISK_BYTES = '12';
    writeMedia(USER, 'taken', bytes('12345678'), { mime: 'image/png' }); // 8 used
    // Unknown declared size sails through the pre-check; the 10 real bytes don't fit.
    const msg = mediaMsg({}, { size: undefined });
    expect(await resolveMediaForMessage(USER, msg))
        .toEqual({ mediaStatus: 'unavailable', mediaError: 'disk_full' });
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
