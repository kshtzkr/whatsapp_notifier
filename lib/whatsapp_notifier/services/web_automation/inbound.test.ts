import { test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    INBOUND_QUEUE_CAP,
    SELF_SEND_MAX,
    SELF_SEND_TTL_MS,
    configureInbound,
    loadTargets,
    rememberTarget,
    rememberLidAlias,
    rememberSelfSend,
    isSelfSend,
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
const OPERATOR = '919000000001@c.us'; // the linked number's own jid (fromMe sender)

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

    expect(shouldCapture('1', msg({ from: '12@g.us' }))).toBe(false);     // group
    expect(shouldCapture('1', msg({ isStatus: true }))).toBe(false);      // status
    expect(shouldCapture('1', msg({ from: 'status@broadcast' }))).toBe(false);
    expect(shouldCapture('1', msg({ type: 'e2e_notification' }))).toBe(false); // system event
    expect(shouldCapture('1', msg({ type: 'call_log' }))).toBe(false);        // system event
    expect(shouldCapture('1', null)).toBe(false);                         // junk
});

// 0.8.0 two-way capture: operator-sent (fromMe) messages are kept, and every
// jid gate moves to the COUNTERPARTY (msg.to) — the operator's own `from` is
// always @c.us and must not vouch for a group/status post.
test('shouldCapture: fromMe messages gate on the counterparty at msg.to', () => {
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: CUST }))).toBe(true);
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: '125417440686124@lid' }))).toBe(true);

    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: '12@g.us' }))).toBe(false);          // own group post
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: 'status@broadcast' }))).toBe(false); // own status
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR }))).toBe(false);                         // no counterparty
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: CUST, isStatus: true }))).toBe(false);
    expect(shouldCapture('1', msg({ fromMe: true, from: OPERATOR, to: CUST, type: 'revoked' }))).toBe(false); // system event
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

// fromMe normalization: the wire gains fromMe + to (counterparty), and the
// fallback id keys on the counterparty — the operator's `from` is shared by
// every chat, so id-less sends to two customers in the same second must not
// collide in the host's messageId dedupe.
test('normalizeInbound marks fromMe and carries the counterparty at to', () => {
    const out = normalizeInbound(msg({ fromMe: true, from: OPERATOR, to: CUST, body: 'on my way' }));
    expect(out).toEqual({
        from: OPERATOR, to: CUST, fromMe: true,
        body: 'on my way', messageId: 'true_919999000001@c.us_ABC',
        timestamp: 1717000000, type: 'chat'
    });
});

test('normalizeInbound falls back to a counterparty-keyed id for fromMe', () => {
    const out = normalizeInbound({ fromMe: true, from: OPERATOR, to: CUST, timestamp: 42 });
    expect(out.messageId).toBe(`${CUST}-42`);
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

    await processInbound('pi5', mediaMsg({ fromMe: true }), deps); // fromMe without a counterparty
    await processInbound('pi5', mediaMsg({ from: '12@g.us' }), deps);

    expect(resolveCalls).toBe(0);
    expect(drainInbound('pi5')).toEqual([]);
});

// ── processInbound: operator-sent (fromMe) leg ──

test('processInbound captures a fromMe message without a contact lookup', async () => {
    let contactCalls = 0;
    const m = msg({
        fromMe: true, from: OPERATOR, to: CUST, body: 'on my way',
        getContact: async () => { contactCalls += 1; return { pushname: 'The Operator' }; }
    });

    const pushed: InboundMsg[] = [];
    await processInbound('fm1', m, {
        resolveMedia: async () => ({ mediaStatus: 'available' as const }),
        push: (_u, inbound) => pushed.push(inbound)
    });

    const drained = drainInbound('fm1');
    expect(drained.length).toBe(1);
    expect(drained[0].fromMe).toBe(true);
    expect(drained[0].to).toBe(CUST);
    expect(drained[0].body).toBe('on my way');
    expect('senderName' in drained[0]).toBe(false); // the operator needs no display name…
    expect(contactCalls).toBe(0);                   // …so the puppeteer roundtrip is skipped
    expect(pushed).toEqual(drained);                // webhook saw the same payload
});

// A fromMe message to a brand-new number = operator opened the chat in the
// WhatsApp app. It must join the backfill allowlist exactly like a /send
// recipient, or the conversation would vanish from disconnect-window recovery.
test('processInbound allowlists the fromMe counterparty for backfill', async () => {
    const m = msg({ fromMe: true, from: OPERATOR, to: CUST });

    await processInbound('fm2', m, { resolveMedia: async () => ({ mediaStatus: 'available' as const }) });

    expect(loadTargets('fm2').has(CUST)).toBe(true);
    expect(loadTargets('fm2').has(OPERATOR)).toBe(false); // counterparty, not self
});

test('processInbound resolves media for operator-sent media messages', async () => {
    useMediaRoot('media-fromme');
    const m = mediaMsg({ fromMe: true, from: OPERATOR, to: CUST });

    await processInbound('fm3', m, { resolveMedia: resolveMediaForMessage });

    const drained = drainInbound('fm3');
    expect(drained.length).toBe(1);
    expect(drained[0].fromMe).toBe(true);
    expect(drained[0].mediaStatus).toBe('available');
    expect(drained[0].mediaSize).toBe(10);
});

// An @lid counterparty on fromMe has no phone the host can thread on and no
// contact handle to resolve it through (getContact resolves the sender — the
// operator). Dropped with a log, before any download — same disk-hygiene rule
// as the inbound @lid drop.
test('processInbound drops a fromMe message to an @lid chat before any download', async () => {
    let resolveCalls = 0;
    const m = mediaMsg({ fromMe: true, from: OPERATOR, to: LID_FROM });

    await processInbound('fm4', m, {
        resolveMedia: async () => { resolveCalls += 1; return { mediaStatus: 'available' as const }; }
    });

    expect(resolveCalls).toBe(0);
    expect(drainInbound('fm4')).toEqual([]);
    expect(loadTargets('fm4').size).toBe(0); // an unmatchable chat earns no allowlist slot
});

// ── Self-send echo suppression ──
//
// Every /send fires its own fromMe message_create echo. A registry hit must
// suppress the WHOLE pipeline: no media re-download (each platform media send
// would otherwise re-fetch its own attachment and burn the shared disk cap on
// bytes nobody fetches), no queue slot, no webhook — the host already got
// this id from the /send response.

test('processOwnMessage suppresses a registered self-send echo entirely', async () => {
    const mediaRoot = useMediaRoot('media-self-send');
    let resolveCalls = 0;
    const m = mediaMsg({ fromMe: true, from: OPERATOR, to: CUST });
    rememberSelfSend('ss1', m.id._serialized);

    const pushed: InboundMsg[] = [];
    await processInbound('ss1', m, {
        resolveMedia: (u, message) => { resolveCalls += 1; return resolveMediaForMessage(u, message); },
        push: (_u, inbound) => pushed.push(inbound)
    });

    expect(resolveCalls).toBe(0);               // no media re-download
    expect(drainInbound('ss1')).toEqual([]);    // no queue slot
    expect(pushed).toEqual([]);                 // no webhook
    expect(existsSync(mediaRoot)).toBe(false);  // nothing hit the disk
    expect(loadTargets('ss1').size).toBe(0);    // /send already allowlisted it
});

test('a fromMe message NOT in the registry flows through unchanged', async () => {
    rememberSelfSend('ss2', 'some-other-send');
    const m = msg({ fromMe: true, from: OPERATOR, to: CUST, body: 'typed on the phone' });

    await processInbound('ss2', m, { resolveMedia: async () => ({ mediaStatus: 'available' as const }) });

    const drained = drainInbound('ss2');
    expect(drained.length).toBe(1);
    expect(drained[0].fromMe).toBe(true);
    expect(drained[0].body).toBe('typed on the phone');
});

test('self-send ids expire after the TTL and the registry stays bounded', () => {
    const now = 1717000000000;
    rememberSelfSend('ss3', 'echo-1', now);
    expect(isSelfSend('ss3', 'echo-1', now + SELF_SEND_TTL_MS)).toBe(true);      // still inside
    expect(isSelfSend('ss3', 'echo-1', now + SELF_SEND_TTL_MS + 1)).toBe(false); // expired
    expect(isSelfSend('ss3', 'echo-1', now)).toBe(false);                        // …and forgotten

    // Bound: the oldest id is evicted once the per-user cap overflows.
    for (let i = 0; i < SELF_SEND_MAX + 1; i++) rememberSelfSend('ss3', `m${i}`, now);
    expect(isSelfSend('ss3', 'm0', now)).toBe(false);                 // evicted oldest
    expect(isSelfSend('ss3', 'm1', now)).toBe(true);
    expect(isSelfSend('ss3', `m${SELF_SEND_MAX}`, now)).toBe(true);   // newest kept
});

test('isSelfSend scopes ids per user and misses an empty registry', () => {
    rememberSelfSend('ss4', 'echo-1');
    expect(isSelfSend('ss4', 'echo-1')).toBe(true);
    expect(isSelfSend('other-user', 'echo-1')).toBe(false); // per-user scope
    expect(isSelfSend('never-sent', 'anything')).toBe(false);
});

// Restart-equivalent: the registry is in-memory, so after a service restart
// (empty registry) the echo falls back to flowing through — the host's
// id-dedupe catches it, harmless.
test('after a restart (empty registry) the echo flows through to the host', async () => {
    rememberSelfSend('ss5', 'true_echo@c.us_X');
    resetInboundState(); // the restart
    configureInbound(dirFor);

    const m = msg({ fromMe: true, from: OPERATOR, to: CUST, id: { _serialized: 'true_echo@c.us_X' } });
    await processInbound('ss5', m, { resolveMedia: async () => ({ mediaStatus: 'available' as const }) });

    expect(drainInbound('ss5').length).toBe(1);
});

test('clearInbound drops the self-send registry so suppression cannot leak across a re-pair', () => {
    rememberSelfSend('ss6', 'echo-1');
    clearInbound('ss6');
    expect(isSelfSend('ss6', 'echo-1')).toBe(false);
});

// Reconnect recovery: fetchMessages returns BOTH directions, so with fromMe
// accepted the backfill replays operator-app messages typed during a
// disconnect window alongside the customer replies.
test('backfillTargets replays both directions through the capture pipeline', async () => {
    rememberTarget('bf3', CUST);
    const client: ChatResolver = {
        async getChatById(_chatId: string) {
            return fakeChat([
                msg({ body: 'customer-reply', getContact: async () => ({}) }),
                msg({ fromMe: true, from: OPERATOR, to: CUST, body: 'operator-app', id: { _serialized: 'op1' } })
            ]);
        },
        async getContactById(_chatId: string) { throw new Error('unused'); }
    };

    await backfillTargets('bf3', client, (userId, m) =>
        processInbound(userId, m, { resolveMedia: async () => ({ mediaStatus: 'available' as const }) }));

    const drained = drainInbound('bf3');
    expect(drained.map((m) => m.body).sort()).toEqual(['customer-reply', 'operator-app']);
    expect(drained.find((m) => m.body === 'operator-app')?.fromMe).toBe(true);
    expect(drained.find((m) => m.body === 'customer-reply')?.fromMe).toBeUndefined();
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
