import { test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    INBOUND_QUEUE_CAP,
    configureInbound,
    loadTargets,
    rememberTarget,
    rememberLidAlias,
    resolveChat,
    backfillTargets,
    enqueueInbound,
    drainInbound,
    clearInbound,
    shouldCapture,
    normalizeInbound,
    processInbound,
    resetInboundState,
    type ChatResolver,
    type InboundMsg
} from './inbound';
import { configureMedia, resolveMediaForMessage, mediaDiskBytes, resetMediaState } from './media';

const root = mkdtempSync(join(tmpdir(), 'wa-inbound-'));
const dirFor = (userId: string) => join(root, `session-user-${userId}`);

beforeEach(() => {
    resetInboundState();
    configureInbound(dirFor);
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const CUST = '919999000001@c.us';

function msg(overrides: any = {}) {
    return {
        from: CUST,
        body: 'hello',
        fromMe: false,
        isStatus: false,
        id: { _serialized: 'true_919999000001@c.us_ABC' },
        timestamp: 1717000000,
        type: 'chat',
        ...overrides
    };
}

// G10 — sanity filter (captures any real inbound 1:1; host matches relevance)
test('shouldCapture: any inbound 1:1 chat, no allowlist gate', () => {
    expect(shouldCapture('1', msg())).toBe(true);                         // @c.us 1:1
    expect(shouldCapture('1', msg({ from: '125417440686124@lid' }))).toBe(true); // @lid 1:1

    expect(shouldCapture('1', msg({ type: 'image' }))).toBe(true);        // media is real content

    expect(shouldCapture('1', msg({ fromMe: true }))).toBe(false);       // own message
    expect(shouldCapture('1', msg({ from: '12@g.us' }))).toBe(false);     // group
    expect(shouldCapture('1', msg({ isStatus: true }))).toBe(false);      // status
    expect(shouldCapture('1', msg({ from: 'status@broadcast' }))).toBe(false);
    expect(shouldCapture('1', msg({ type: 'e2e_notification' }))).toBe(false); // system event
    expect(shouldCapture('1', msg({ type: 'call_log' }))).toBe(false);        // system event
    expect(shouldCapture('1', null)).toBe(false);                         // junk
});

// allowlist persists to disk + reloads
test('rememberTarget persists and loadTargets reloads from disk', () => {
    rememberTarget('1', CUST);
    const file = join(dirFor('1'), 'outbound_targets.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([CUST]);

    resetInboundState(); // drop in-memory cache → must reload from file
    expect(loadTargets('1').has(CUST)).toBe(true);
});

// G11 — enqueue + drain
test('enqueue then drain returns once, then empties', () => {
    enqueueInbound('1', normalizeInbound(msg()));
    enqueueInbound('1', normalizeInbound(msg({ id: { _serialized: 'm2' } })));

    const first = drainInbound('1');
    expect(first.length).toBe(2);

    const second = drainInbound('1');
    expect(second.length).toBe(0);
});

// G12 — queue cap (drop oldest)
test('queue is bounded to INBOUND_QUEUE_CAP (drops oldest)', () => {
    for (let i = 0; i < INBOUND_QUEUE_CAP + 5; i++) {
        enqueueInbound('1', normalizeInbound(msg({ id: { _serialized: `m${i}` }, body: String(i) })));
    }
    const drained = drainInbound('1');
    expect(drained.length).toBe(INBOUND_QUEUE_CAP);
    expect(drained[0].body).toBe('5');                       // 0-4 dropped
    expect(drained[drained.length - 1].body).toBe(String(INBOUND_QUEUE_CAP + 4));
});

// G13 — logout must not strand the queue (would replay into the WRONG pairing)
test('clearInbound empties the queue so a re-pair cannot replay old messages', () => {
    enqueueInbound('lo1', normalizeInbound(msg()));
    enqueueInbound('lo1', normalizeInbound(msg({ id: { _serialized: 'm2' } })));
    enqueueInbound('lo2', normalizeInbound(msg({ id: { _serialized: 'other-user' } })));

    clearInbound('lo1');

    expect(drainInbound('lo1')).toEqual([]);     // logout dropped the backlog
    expect(drainInbound('lo2').length).toBe(1);  // scoped per user

    // Re-pair: only messages captured AFTER the logout surface.
    enqueueInbound('lo1', normalizeInbound(msg({ id: { _serialized: 'fresh' }, body: 'fresh' })));
    const replayed = drainInbound('lo1');
    expect(replayed.length).toBe(1);
    expect(replayed[0].body).toBe('fresh');
});

test('clearInbound drops the cached allowlist so a wiped session dir is not resurrected', () => {
    rememberTarget('lo3', CUST);
    expect(loadTargets('lo3').has(CUST)).toBe(true);

    // Logout wipes the session dir (incl. outbound_targets.json) from disk...
    rmSync(dirFor('lo3'), { recursive: true, force: true });
    // ...but without clearInbound the in-memory cache would still serve CUST.
    clearInbound('lo3');

    expect(loadTargets('lo3').size).toBe(0);
});

// @lid alias joins the allowlist so backfill can re-open privacy-number chats
test('rememberLidAlias stores the @lid chat id for a known target', () => {
    const LID = '125417440686124@lid';
    rememberTarget('la1', CUST);

    rememberLidAlias('la1', LID, CUST);

    expect(loadTargets('la1').has(LID)).toBe(true);
    expect(loadTargets('la1').has(CUST)).toBe(true);
});

test('rememberLidAlias ignores unknown senders and non-@lid raw ids', () => {
    rememberTarget('la2', CUST);

    rememberLidAlias('la2', '999@lid', '918888000000@c.us'); // resolved not a target
    rememberLidAlias('la2', CUST, CUST);                     // raw is already @c.us

    expect(loadTargets('la2')).toEqual(new Set([CUST]));
});

// backfill resolves chats directly, then via contact, and skips dead targets
function fakeChat(msgs: any[]) {
    return { fetchMessages: async (_opts: { limit: number }) => msgs };
}

test('backfillTargets replays direct chats and falls back to the contact for @lid', async () => {
    const LID = '125417440686124@lid';
    rememberTarget('bf1', CUST);
    rememberTarget('bf1', LID);
    rememberTarget('bf1', 'gone@c.us');

    const client: ChatResolver = {
        async getChatById(chatId: string) {
            if (chatId === CUST) return fakeChat([msg({ body: 'direct' })]);
            throw new Error('chat not found'); // @lid + stale ids fail here
        },
        async getContactById(chatId: string) {
            if (chatId === LID) return { getChat: async () => fakeChat([msg({ from: LID, body: 'via-contact' })]) };
            throw new Error('contact not found');
        }
    };

    const captured: string[] = [];
    await backfillTargets('bf1', client, (_userId, m) => { captured.push(m.body); });

    expect(captured.sort()).toEqual(['direct', 'via-contact']);
});

test('backfillTargets survives a chat whose fetchMessages blows up', async () => {
    rememberTarget('bf2', CUST);
    rememberTarget('bf2', '918888000000@c.us');

    const client: ChatResolver = {
        async getChatById(chatId: string) {
            if (chatId === CUST) return { fetchMessages: async () => { throw new Error('boom'); } };
            return fakeChat([msg({ body: 'ok' })]);
        },
        async getContactById(_chatId: string) {
            throw new Error('unused');
        }
    };

    const captured: string[] = [];
    await backfillTargets('bf2', client, (_userId, m) => { captured.push(m.body); });

    expect(captured).toEqual(['ok']);
});

test('resolveChat returns null when both lookups fail', async () => {
    const client: ChatResolver = {
        async getChatById() { throw new Error('no chat'); },
        async getContactById() { throw new Error('no contact'); }
    };
    expect(await resolveChat(client, 'x@c.us')).toBeNull();
});

// normalize shape + messageId fallback
test('normalizeInbound maps fields and falls back on missing id', () => {
    const a = normalizeInbound(msg());
    expect(a).toEqual({
        from: CUST, body: 'hello', messageId: 'true_919999000001@c.us_ABC',
        timestamp: 1717000000, type: 'chat'
    });

    const b = normalizeInbound({ from: CUST, timestamp: 42 });
    expect(b.messageId).toBe(`${CUST}-42`);                  // fallback id
    expect(b.body).toBe('');
    expect(b.type).toBe('chat');
});

// ── processInbound (capture pipeline ordering) ──

const LID_FROM = '125417440686124@lid';

function mediaMsg(overrides: any = {}) {
    return msg({
        hasMedia: true,
        type: 'image',
        _data: { size: 10, mimetype: 'image/jpeg' },
        getContact: async () => ({ pushname: 'Asha' }),
        downloadMedia: async () => ({
            data: Buffer.from('jpeg-bytes').toString('base64'),
            mimetype: 'image/jpeg',
            filename: 'beach.jpg'
        }),
        ...overrides
    });
}

// Wire the real media store at a per-test root so "nothing written" is a
// statement about the disk, not about a stub.
function useMediaRoot(name: string) {
    const mediaRoot = join(root, name);
    configureMedia(() => mediaRoot);
    resetMediaState();
    return mediaRoot;
}

test('processInbound drops an unresolvable @lid BEFORE any media download', async () => {
    const mediaRoot = useMediaRoot('media-lid-drop');
    let resolveCalls = 0;
    let downloads = 0;
    const m = mediaMsg({
        from: LID_FROM,
        getContact: async () => ({ pushname: 'Asha' }), // no phone → unresolvable
        downloadMedia: async () => { downloads += 1; return null; }
    });

    await processInbound('pi1', m, {
        resolveMedia: (u, message) => { resolveCalls += 1; return resolveMediaForMessage(u, message); }
    });

    expect(resolveCalls).toBe(0);               // dropped before the download path
    expect(downloads).toBe(0);
    expect(drainInbound('pi1')).toEqual([]);
    expect(existsSync(mediaRoot)).toBe(false);  // nothing written to disk
    expect(mediaDiskBytes()).toBe(0);
});

test('processInbound resolves an @lid sender, then downloads for the kept message', async () => {
    useMediaRoot('media-lid-kept');
    rememberTarget('pi2', CUST); // resolved phone is a known outbound target
    const m = mediaMsg({
        from: LID_FROM,
        getContact: async () => ({ pushname: 'Asha', number: '919999000001' })
    });

    const pushed: InboundMsg[] = [];
    await processInbound('pi2', m, {
        resolveMedia: resolveMediaForMessage,
        push: (_u, inbound) => pushed.push(inbound)
    });

    const drained = drainInbound('pi2');
    expect(drained.length).toBe(1);
    expect(drained[0].from).toBe(CUST);                     // resolved to the phone
    expect(drained[0].senderName).toBe('Asha');
    expect(drained[0].mediaStatus).toBe('available');
    expect(drained[0].mediaSize).toBe(10);
    expect(pushed).toEqual(drained);                        // webhook saw the same payload
    expect(loadTargets('pi2').has(LID_FROM)).toBe(true);    // alias allowlisted for backfill
});

test('processInbound keeps an @c.us message when the contact lookup fails', async () => {
    useMediaRoot('media-contact-fail');
    const m = msg({ getContact: async () => { throw new Error('boom'); } });

    await processInbound('pi3', m, { resolveMedia: resolveMediaForMessage });

    const drained = drainInbound('pi3');
    expect(drained.length).toBe(1);
    expect(drained[0].from).toBe(CUST);
    expect('senderName' in drained[0]).toBe(false);
});

test('processInbound enqueues type-only when the media resolver reports a failure', async () => {
    const m = mediaMsg({});
    await processInbound('pi4', m, {
        resolveMedia: async () => ({ mediaStatus: 'unavailable', mediaError: 'download_failed' })
    });

    const drained = drainInbound('pi4');
    expect(drained.length).toBe(1);
    expect(drained[0].hasMedia).toBe(true);
    expect(drained[0].mediaStatus).toBe('unavailable');
    expect(drained[0].mediaError).toBe('download_failed');
});

test('processInbound rejects filtered messages without resolving anything', async () => {
    let resolveCalls = 0;
    const deps = { resolveMedia: async () => { resolveCalls += 1; return { mediaStatus: 'available' as const }; } };

    await processInbound('pi5', mediaMsg({ fromMe: true }), deps);
    await processInbound('pi5', mediaMsg({ from: '12@g.us' }), deps);

    expect(resolveCalls).toBe(0);
    expect(drainInbound('pi5')).toEqual([]);
});

// 0.6.0 wire back-compat: text payloads must keep the exact five-field shape —
// no media keys, not even hasMedia:false (hosts key-gate on hasMedia presence).
test('normalizeInbound keeps the 0.6.0 shape for non-media messages', () => {
    const plain = normalizeInbound(msg({ hasMedia: false }));
    expect(Object.keys(plain).sort()).toEqual(['body', 'from', 'messageId', 'timestamp', 'type']);
});

test('normalizeInbound flags hasMedia even when no verdict is supplied', () => {
    const out = normalizeInbound(msg({ hasMedia: true, type: 'image' }));
    expect(out.hasMedia).toBe(true);
    expect(out.type).toBe('image');
    expect('mediaStatus' in out).toBe(false);                // verdict is capture-level
});

test('normalizeInbound merges an available media verdict into the payload', () => {
    const out = normalizeInbound(msg({ hasMedia: true, type: 'image' }), {
        mediaStatus: 'available', mediaMime: 'image/jpeg', mediaFilename: 'beach.jpg', mediaSize: 1024
    });
    expect(out).toEqual({
        from: CUST, body: 'hello', messageId: 'true_919999000001@c.us_ABC',
        timestamp: 1717000000, type: 'image',
        hasMedia: true, mediaStatus: 'available',
        mediaMime: 'image/jpeg', mediaFilename: 'beach.jpg', mediaSize: 1024
    });
});

test('normalizeInbound merges an unavailable verdict with its typed reason', () => {
    const out = normalizeInbound(msg({ hasMedia: true, type: 'video' }), {
        mediaStatus: 'unavailable', mediaError: 'unsupported_type'
    });
    expect(out.hasMedia).toBe(true);
    expect(out.mediaStatus).toBe('unavailable');
    expect(out.mediaError).toBe('unsupported_type');
    expect('mediaMime' in out).toBe(false);
});
