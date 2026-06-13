import { test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    CHAT_LIST_CAP,
    DEFAULT_HISTORY_LIMIT,
    MAX_HISTORY_LIMIT,
    HISTORY_MEDIA_ERROR,
    summarizeChats,
    clampHistoryLimit,
    normalizeHistoryChatId,
    historyMediaInfo,
    replayHistory,
    chatsResponse,
    historyResponse,
    findMessage,
    refetchResponse,
    type GatedClient,
    type HistoryDeps,
    type RefetchDeps
} from './history';
import { configureInbound, loadTargets, resetInboundState, type ChatLike } from './inbound';
import {
    configureMedia,
    resetMediaState,
    mediaExists,
    userDirBytes,
    resolveMediaForMessage,
    type MediaResolution
} from './media';

const root = mkdtempSync(join(tmpdir(), 'wa-history-'));
const dirFor = (userId: string) => join(root, `session-user-${userId}`);

let mediaCase = 0;

beforeEach(() => {
    resetInboundState();
    configureInbound(dirFor);
    // Each example gets a fresh media root so the refetch store tests don't
    // bleed bytes into one another. The resolver must be PURE (no side effect
    // per call) — bump the case index once here, not inside the closure.
    const mediaRoot = join(root, `media-${mediaCase++}`);
    configureMedia(() => mediaRoot);
    resetMediaState();
    delete process.env.WHATSAPP_MEDIA_MAX_USER_BYTES;
});

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const CUST = '919999000001@c.us';
const OPERATOR = '919000000001@c.us';

function chat(id: string, overrides: any = {}) {
    return { id: { _serialized: id }, name: 'Asha', timestamp: 1717000000, ...overrides };
}

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

// ── summarizeChats ──

test('summarizeChats keeps 1:1 @c.us chats only', () => {
    const summaries = summarizeChats([
        chat(CUST),
        chat('12036304@g.us'),                       // group
        chat('status@broadcast'),                    // status
        chat('125417440686124@lid'),                 // privacy chat — no phone to thread on
        { name: 'no id at all' },                    // junk
        { id: { _serialized: 42 }, name: 'junk' }    // non-string id
    ]);

    expect(summaries).toEqual([{ id: CUST, name: 'Asha', lastMessageAt: 1717000000 }]);
});

test('summarizeChats maps name and timestamp best-effort (null-safe)', () => {
    const summaries = summarizeChats([
        chat(CUST, { name: '', timestamp: undefined }),
        chat('918@c.us', { name: 7, timestamp: 'soon' })
    ]);

    expect(summaries).toEqual([
        { id: CUST, name: null, lastMessageAt: null },
        { id: '918@c.us', name: null, lastMessageAt: null }
    ]);
});

test('summarizeChats orders newest first and caps the list at CHAT_LIST_CAP', () => {
    const many = [];
    for (let i = 0; i < CHAT_LIST_CAP + 20; i++) {
        many.push(chat(`91${i}@c.us`, { timestamp: i }));
    }
    many.push(chat('oldest@c.us', { timestamp: null })); // no timestamp sorts oldest

    const summaries = summarizeChats(many);

    expect(summaries.length).toBe(CHAT_LIST_CAP);
    expect(summaries[0].lastMessageAt).toBe(CHAT_LIST_CAP + 19);            // newest first
    expect(summaries[summaries.length - 1].lastMessageAt).toBe(20);        // oldest 20 + null cut
    expect(summaries.find((s) => s.id === 'oldest@c.us')).toBeUndefined(); // capped away
});

test('summarizeChats tolerates a non-array result', () => {
    expect(summarizeChats(undefined as any)).toEqual([]);
    expect(summarizeChats(null as any)).toEqual([]);
});

// ── clampHistoryLimit ──

test('clampHistoryLimit defaults absent and non-numeric input to 50', () => {
    expect(clampHistoryLimit(undefined)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit(null)).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit('a lot')).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit({})).toBe(DEFAULT_HISTORY_LIMIT);
    expect(clampHistoryLimit(NaN)).toBe(DEFAULT_HISTORY_LIMIT);
});

test('clampHistoryLimit clamps to 1..200 and floors floats', () => {
    expect(clampHistoryLimit(0)).toBe(1);
    expect(clampHistoryLimit(-5)).toBe(1);
    expect(clampHistoryLimit(1)).toBe(1);
    expect(clampHistoryLimit(75.9)).toBe(75);
    expect(clampHistoryLimit('120')).toBe(120);
    expect(clampHistoryLimit(MAX_HISTORY_LIMIT)).toBe(200);
    expect(clampHistoryLimit(201)).toBe(200);
    expect(clampHistoryLimit(100000)).toBe(200);
});

// ── normalizeHistoryChatId ──

test('normalizeHistoryChatId appends @c.us to bare numbers like /send', () => {
    expect(normalizeHistoryChatId('919999000001')).toBe(CUST);
    expect(normalizeHistoryChatId(` ${CUST} `)).toBe(CUST); // already suffixed + trimmed
});

test('normalizeHistoryChatId rejects empty, non-string and non-1:1 ids', () => {
    expect(normalizeHistoryChatId(undefined)).toBeNull();
    expect(normalizeHistoryChatId(null)).toBeNull();
    expect(normalizeHistoryChatId(42)).toBeNull();
    expect(normalizeHistoryChatId('')).toBeNull();
    expect(normalizeHistoryChatId('   ')).toBeNull();
    expect(normalizeHistoryChatId('12036304@g.us')).toBeNull();          // group
    expect(normalizeHistoryChatId('status@broadcast')).toBeNull();       // status
    expect(normalizeHistoryChatId('125417440686124@lid')).toBeNull();    // privacy id
});

// ── replayHistory ──

function chatWith(messages: any[], onFetch?: (opts: { limit: number }) => void): ChatLike {
    return {
        fetchMessages: async (opts) => {
            if (onFetch) onFetch(opts);
            return messages;
        }
    };
}

test('replayHistory normalizes BOTH directions like live capture', async () => {
    const history = await replayHistory('1', chatWith([
        msg({ body: 'customer says hi' }),
        msg({
            fromMe: true, from: OPERATOR, to: CUST, body: 'operator replies',
            id: { _serialized: 'true_919999000001@c.us_OP1' }, timestamp: 1717000100
        })
    ]), 50);

    expect(history.length).toBe(2);
    // Inbound keeps the exact live wire shape — no fromMe/to keys.
    expect(history[0]).toEqual({
        from: CUST, body: 'customer says hi',
        messageId: 'true_919999000001@c.us_ABC', timestamp: 1717000000, type: 'chat'
    });
    // Operator-sent carries fromMe + the counterparty at `to`.
    expect(history[1]).toEqual({
        from: OPERATOR, to: CUST, fromMe: true, body: 'operator replies',
        messageId: 'true_919999000001@c.us_OP1', timestamp: 1717000100, type: 'chat'
    });
});

test('replayHistory marks media unavailable WITHOUT downloading', async () => {
    let downloads = 0;
    const history = await replayHistory('1', chatWith([
        msg({
            type: 'image', hasMedia: true, body: '',
            downloadMedia: async () => { downloads += 1; return null; }
        })
    ]), 50);

    expect(downloads).toBe(0);
    expect(historyMediaInfo()).toEqual({ mediaStatus: 'unavailable', mediaError: 'history' });
    expect(history[0]).toEqual({
        from: CUST, body: '', messageId: 'true_919999000001@c.us_ABC',
        timestamp: 1717000000, type: 'image',
        hasMedia: true, mediaStatus: 'unavailable', mediaError: HISTORY_MEDIA_ERROR
    });
});

test('replayHistory skips messages that fail shouldCapture', async () => {
    const history = await replayHistory('1', chatWith([
        msg(),
        msg({ type: 'e2e_notification', id: { _serialized: 'sys1' } }),   // system event
        msg({ isStatus: true, id: { _serialized: 'st1' } }),              // status
        msg({ from: '12@g.us', id: { _serialized: 'g1' } }),              // group post
        null                                                              // junk entry
    ]), 50);

    expect(history.length).toBe(1);
    expect(history[0].messageId).toBe('true_919999000001@c.us_ABC');
});

test('replayHistory returns oldest-first even when the chat yields newest-first', async () => {
    const history = await replayHistory('1', chatWith([
        msg({ id: { _serialized: 'm3' }, timestamp: 1717000300 }),
        msg({ id: { _serialized: 'm1' }, timestamp: 1717000100 }),
        msg({ id: { _serialized: 'm2' }, timestamp: 1717000200 })
    ]), 50);

    expect(history.map((m) => m.messageId)).toEqual(['m1', 'm2', 'm3']);
});

test('replayHistory passes the limit through and tolerates a non-array result', async () => {
    let seenLimit = 0;
    await replayHistory('1', chatWith([], ({ limit }) => { seenLimit = limit; }), 37);
    expect(seenLimit).toBe(37);

    expect(await replayHistory('1', chatWith(undefined as any), 5)).toEqual([]);
});

// ── route gating (shared by both responses) ──

function readyClient(overrides: any = {}): GatedClient {
    return {
        state: 'AUTHENTICATED',
        ready: true,
        lastUsed: 0,
        client: {
            getChats: async () => [chat(CUST)],
            getChatById: async (_id: string) => chatWith([msg()]),
            getContactById: async () => { throw new Error('not needed'); }
        },
        ...overrides
    };
}

function depsWith(data: GatedClient, overrides: Partial<HistoryDeps> = {}): HistoryDeps & { getClientCalls: number } {
    const deps: any = {
        getClientCalls: 0,
        hasPaired: () => true,
        getClient: async () => { deps.getClientCalls += 1; return data; },
        resolveChat: async (client: any, chatId: string) => {
            try { return await client.getChatById(chatId); } catch (_) { return null; }
        },
        rememberTarget: (userId: string, chatId: string) => loadTargets(userId).add(chatId),
        ...overrides
    };
    return deps;
}

test('both routes enforce X-WA-Token before touching any client', async () => {
    const deps = depsWith(readyClient(), { hasPaired: () => { throw new Error('gate must not run'); } });

    const chats = await chatsResponse('1', 'wrong', 'expected', deps);
    expect(chats.status).toBe(401);
    expect(await chats.json()).toEqual({ success: false, error: 'unauthorized' });

    const history = await historyResponse('1', { chatId: CUST }, undefined, 'expected', deps);
    expect(history.status).toBe(401);
    expect(deps.getClientCalls).toBe(0);
});

test('both routes accept a matching token and stay open when none is configured', async () => {
    const deps = depsWith(readyClient());

    expect((await chatsResponse('1', 'secret', 'secret', deps)).status).toBe(200);
    expect((await chatsResponse('1', undefined, undefined, deps)).status).toBe(200);
    expect((await historyResponse('1', { chatId: CUST }, 'secret', 'secret', deps)).status).toBe(200);
});

test('both routes fast-reject a never-paired user WITHOUT creating a client', async () => {
    const deps = depsWith(readyClient(), { hasPaired: () => false });

    const chats = await chatsResponse('1', undefined, undefined, deps);
    expect(chats.status).toBe(401);
    expect((await chats.json()).error).toMatch(/pair via QR/);

    const history = await historyResponse('1', { chatId: CUST }, undefined, undefined, deps);
    expect(history.status).toBe(401);
    expect(deps.getClientCalls).toBe(0); // the /send no-Chromium rule
});

test('both routes answer 401 for a paired but not-ready client', async () => {
    for (const data of [
        readyClient({ ready: false }),                          // AUTHENTICATED but unready
        readyClient({ state: 'QR_REQUIRED', ready: false })     // pairing-screen zombie
    ]) {
        const deps = depsWith(data);
        const chats = await chatsResponse('1', undefined, undefined, deps);
        expect(chats.status).toBe(401);
        expect((await chats.json()).error).toBe('User not authenticated');

        const history = await historyResponse('1', { chatId: CUST }, undefined, undefined, deps);
        expect(history.status).toBe(401);
    }
});

// ── GET /chats route contract ──

test('chatsResponse lists summarized chats and refreshes the idle clock', async () => {
    const data = readyClient({
        client: {
            getChats: async () => [
                chat('917@c.us', { timestamp: 200 }),
                chat('12@g.us'),
                chat(CUST, { timestamp: 300 })
            ]
        }
    });
    const deps = depsWith(data);

    const res = await chatsResponse('1', undefined, undefined, deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
        success: true,
        chats: [
            { id: CUST, name: 'Asha', lastMessageAt: 300 },
            { id: '917@c.us', name: 'Asha', lastMessageAt: 200 }
        ]
    });
    expect(data.lastUsed).toBeGreaterThan(0);
});

test('chatsResponse maps a getChats failure to a 500 with the message', async () => {
    const deps = depsWith(readyClient({
        client: { getChats: async () => { throw new Error('store not hydrated'); } }
    }));

    const res = await chatsResponse('1', undefined, undefined, deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'store not hydrated' });
});

// ── POST /history route contract ──

test('historyResponse rejects a missing or non-1:1 chatId before the gate', async () => {
    const deps = depsWith(readyClient(), { hasPaired: () => { throw new Error('gate must not run'); } });

    for (const body of [undefined, {}, { chatId: '' }, { chatId: '12@g.us' }, { chatId: '9@lid' }]) {
        const res = await historyResponse('1', body, undefined, undefined, deps);
        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatch(/chatId/);
    }
    expect(deps.getClientCalls).toBe(0);
});

test('historyResponse replays the chat, clamps the limit and allowlists the chat', async () => {
    let seenChatId = '';
    let seenLimit = 0;
    const data = readyClient({
        client: {
            getChatById: async (id: string) => {
                seenChatId = id;
                return chatWith([
                    msg({ id: { _serialized: 'm2' }, timestamp: 2 }),
                    msg({ id: { _serialized: 'm1' }, timestamp: 1, type: 'image', hasMedia: true })
                ], ({ limit }) => { seenLimit = limit; });
            }
        }
    });
    const deps = depsWith(data);

    // Bare number body: normalized to @c.us; limit 100000 clamped to 200.
    const res = await historyResponse('7', { chatId: '919999000001', limit: 100000 }, undefined, undefined, deps);

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.success).toBe(true);
    expect(payload.messages.map((m: any) => m.messageId)).toEqual(['m1', 'm2']); // oldest first
    expect(payload.messages[0]).toMatchObject({
        hasMedia: true, mediaStatus: 'unavailable', mediaError: 'history'
    });
    expect(seenChatId).toBe(CUST);
    expect(seenLimit).toBe(200);
    expect(loadTargets('7').has(CUST)).toBe(true); // joins the reconnect allowlist
    expect(data.lastUsed).toBeGreaterThan(0);
});

test('historyResponse defaults the limit to 50 when the body omits it', async () => {
    let seenLimit = 0;
    const data = readyClient({
        client: { getChatById: async () => chatWith([], ({ limit }) => { seenLimit = limit; }) }
    });

    const res = await historyResponse('1', { chatId: CUST }, undefined, undefined, depsWith(data));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, messages: [] });
    expect(seenLimit).toBe(DEFAULT_HISTORY_LIMIT);
});

test('historyResponse answers 404 (and does not allowlist) when the chat never materialized', async () => {
    let remembered = 0;
    const deps = depsWith(readyClient(), {
        resolveChat: async () => null,
        rememberTarget: () => { remembered += 1; }
    });

    const res = await historyResponse('1', { chatId: CUST }, undefined, undefined, deps);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: 'chat not found' });
    expect(remembered).toBe(0);
});

test('historyResponse maps a fetch failure to a 500 with the message', async () => {
    const deps = depsWith(readyClient(), {
        resolveChat: async () => ({ fetchMessages: async () => { throw new Error('chat hydration failed'); } })
    });

    const res = await historyResponse('1', { chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'chat hydration failed' });
});

// ── findMessage ──

const MSG_ID = 'true_919999000001@c.us_ABC';

function refetchDepsWith(
    data: GatedClient,
    overrides: Partial<RefetchDeps> = {}
): RefetchDeps & { getClientCalls: number } {
    const deps: any = {
        getClientCalls: 0,
        hasPaired: () => true,
        getClient: async () => { deps.getClientCalls += 1; return data; },
        getMessageById: async (client: any, id: string) => client.getMessageById(id),
        resolveChat: async (client: any, chatId: string) => {
            try { return await client.getChatById(chatId); } catch (_) { return null; }
        },
        rememberTarget: () => {},
        // Default fake media pipeline — overridden per test.
        resolveMedia: async (): Promise<MediaResolution> => ({
            mediaStatus: 'available', mediaMime: 'image/jpeg', mediaFilename: 'beach.jpg', mediaSize: 10
        }),
        ...overrides
    };
    return deps;
}

test('findMessage returns the direct getMessageById hit without scanning the chat', async () => {
    let scanned = 0;
    const deps = refetchDepsWith(readyClient(), {
        resolveChat: async () => { scanned += 1; return null; }
    });
    const client = { getMessageById: async (id: string) => ({ id: { _serialized: id }, hasMedia: true }) };

    const found = await findMessage(deps, client, MSG_ID, CUST);
    expect(found.id._serialized).toBe(MSG_ID);
    expect(scanned).toBe(0); // fast path hit → no fallback scan
});

test('findMessage falls back to a chat scan when getMessageById misses', async () => {
    const target = { id: { _serialized: MSG_ID }, hasMedia: true };
    const deps = refetchDepsWith(readyClient(), {
        getMessageById: async () => { throw new Error('not hydrated'); },
        resolveChat: async () => chatWith([
            { id: { _serialized: 'other' } },
            target
        ])
    });

    const found = await findMessage(deps, {}, MSG_ID, CUST);
    expect(found).toBe(target);
});

test('findMessage returns null when neither path turns the message up', async () => {
    // getMessageById returns null, chat scan finds no matching id.
    const nullDirect = refetchDepsWith(readyClient(), {
        getMessageById: async () => null,
        resolveChat: async () => chatWith([{ id: { _serialized: 'someone-else' } }])
    });
    expect(await findMessage(nullDirect, {}, MSG_ID, CUST)).toBeNull();

    // Chat never materialized.
    const noChat = refetchDepsWith(readyClient(), {
        getMessageById: async () => null,
        resolveChat: async () => null
    });
    expect(await findMessage(noChat, {}, MSG_ID, CUST)).toBeNull();

    // fetchMessages throws → swallowed → null (not a 500).
    const throwing = refetchDepsWith(readyClient(), {
        getMessageById: async () => null,
        resolveChat: async () => ({ fetchMessages: async () => { throw new Error('boom'); } })
    });
    expect(await findMessage(throwing, {}, MSG_ID, CUST)).toBeNull();

    // Non-array fetchMessages result tolerated.
    const nonArray = refetchDepsWith(readyClient(), {
        getMessageById: async () => null,
        resolveChat: async () => ({ fetchMessages: async () => undefined as any })
    });
    expect(await findMessage(nonArray, {}, MSG_ID, CUST)).toBeNull();
});

// ── refetchResponse gating ──

test('refetchResponse enforces X-WA-Token before touching any client', async () => {
    const deps = refetchDepsWith(readyClient(), { hasPaired: () => { throw new Error('gate must not run'); } });

    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, 'wrong', 'expected', deps);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'unauthorized' });
    expect(deps.getClientCalls).toBe(0);
});

test('refetchResponse rejects a missing/unsanitizable messageId or non-1:1 chatId before the gate', async () => {
    const deps = refetchDepsWith(readyClient(), { hasPaired: () => { throw new Error('gate must not run'); } });

    // Bad messageId.
    for (const body of [undefined, {}, { messageId: '', chatId: CUST }, { messageId: '//', chatId: CUST }]) {
        const res = await refetchResponse('1', body, undefined, undefined, deps);
        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatch(/messageId/);
    }
    // Good messageId, bad chatId.
    for (const body of [{ messageId: MSG_ID }, { messageId: MSG_ID, chatId: '12@g.us' }]) {
        const res = await refetchResponse('1', body, undefined, undefined, deps);
        expect(res.status).toBe(422);
        expect((await res.json()).error).toMatch(/chatId/);
    }
    expect(deps.getClientCalls).toBe(0);
});

test('refetchResponse fast-rejects a never-paired user WITHOUT creating a client', async () => {
    const deps = refetchDepsWith(readyClient(), { hasPaired: () => false });
    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/pair via QR/);
    expect(deps.getClientCalls).toBe(0);
});

test('refetchResponse answers 401 for a paired but not-ready client', async () => {
    const deps = refetchDepsWith(readyClient({ ready: false }));
    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('User not authenticated');
});

// ── refetchResponse logic ──

test('refetchResponse downloads, stores (cap-enforced) and reports the media available', async () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    // A live message whose downloadMedia yields 10 bytes — routed through the
    // REAL resolveMediaForMessage so the store + cap path is exercised end to end.
    const liveMsg = {
        from: CUST,
        id: { _serialized: MSG_ID },
        timestamp: 1717000000,
        type: 'image',
        hasMedia: true,
        _data: { size: 1024, mimetype: 'image/jpeg' },
        downloadMedia: async () => ({
            data: Buffer.from('jpeg-bytes').toString('base64'),
            mimetype: 'image/jpeg',
            filename: 'beach.jpg'
        })
    };
    const data = readyClient({ client: { getMessageById: async () => liveMsg } });
    const deps = refetchDepsWith(data, { resolveMedia: resolveMediaForMessage });

    const res = await refetchResponse('7', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
        success: true,
        messageId: MSG_ID,
        mediaStatus: 'available',
        mediaMime: 'image/jpeg',
        mediaFilename: 'beach.jpg',
        mediaSize: 10
    });
    expect(mediaExists('7', MSG_ID)).not.toBeNull();  // bytes are on disk for GET /media
    expect(userDirBytes('7')).toBe(10);
    expect(data.lastUsed).toBeGreaterThan(0);
});

test('refetchResponse evicts the user oldest when the refetch blows the per-user cap', async () => {
    process.env.WHATSAPP_MEDIA_MAX_USER_BYTES = '12';
    // Pre-fill the user with an older 8-byte item via the real pipeline.
    const older = {
        from: CUST, id: { _serialized: 'older-msg' }, timestamp: 1, type: 'image', hasMedia: true,
        _data: { mimetype: 'image/png' },
        downloadMedia: async () => ({ data: Buffer.from('12345678').toString('base64'), mimetype: 'image/png' })
    };
    await resolveMediaForMessage('9', older);
    expect(mediaExists('9', 'older-msg')).not.toBeNull();

    const liveMsg = {
        from: CUST, id: { _serialized: MSG_ID }, timestamp: 1717000000, type: 'image', hasMedia: true,
        _data: { mimetype: 'image/jpeg' },
        downloadMedia: async () => ({ data: Buffer.from('jpeg-bytes').toString('base64'), mimetype: 'image/jpeg' })
    };
    const deps = refetchDepsWith(
        readyClient({ client: { getMessageById: async () => liveMsg } }),
        { resolveMedia: resolveMediaForMessage }
    );

    const res = await refetchResponse('9', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);

    expect(res.status).toBe(200);
    // 8 + 10 = 18 > 12 → the older item rolled off, the refetched one kept.
    expect(mediaExists('9', MSG_ID)).not.toBeNull();
    expect(mediaExists('9', 'older-msg')).toBeNull();
    expect(userDirBytes('9')).toBe(10);
});

test('refetchResponse 404s gone when the message is absent upstream', async () => {
    const data = readyClient({ client: { getMessageById: async () => null, getChatById: async () => chatWith([]) } });
    const deps = refetchDepsWith(data);

    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, mediaStatus: 'unavailable', mediaError: 'gone' });
});

test('refetchResponse 404s gone when the found message carries no media', async () => {
    const liveMsg = { id: { _serialized: MSG_ID }, hasMedia: false };
    const deps = refetchDepsWith(readyClient({ client: { getMessageById: async () => liveMsg } }));

    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, mediaStatus: 'unavailable', mediaError: 'gone' });
});

test('refetchResponse maps an unavailable download verdict to a 404 with its typed reason', async () => {
    const liveMsg = { id: { _serialized: MSG_ID }, hasMedia: true };
    const deps = refetchDepsWith(
        readyClient({ client: { getMessageById: async () => liveMsg } }),
        { resolveMedia: async () => ({ mediaStatus: 'unavailable', mediaError: 'expired' }) }
    );

    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, mediaStatus: 'unavailable', mediaError: 'expired' });
});

test('refetchResponse defaults a missing mediaError to gone and omits an absent filename', async () => {
    // Unavailable verdict with NO mediaError → host still gets a typed 'gone'.
    const liveMsg = { id: { _serialized: MSG_ID }, hasMedia: true };
    const goneless = refetchDepsWith(
        readyClient({ client: { getMessageById: async () => liveMsg } }),
        { resolveMedia: async () => ({ mediaStatus: 'unavailable' }) }
    );
    expect(await (await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, goneless)).json())
        .toEqual({ success: false, mediaStatus: 'unavailable', mediaError: 'gone' });

    // Available verdict with no filename → mediaFilename omitted from the body.
    const noName = refetchDepsWith(
        readyClient({ client: { getMessageById: async () => liveMsg } }),
        { resolveMedia: async () => ({ mediaStatus: 'available', mediaMime: 'audio/ogg', mediaSize: 3 }) }
    );
    const body = await (await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, noName)).json();
    expect(body).toEqual({ success: true, messageId: MSG_ID, mediaStatus: 'available', mediaMime: 'audio/ogg', mediaSize: 3 });
    expect('mediaFilename' in body).toBe(false);
});

test('refetchResponse maps an unexpected error to a 500', async () => {
    const deps = refetchDepsWith(
        readyClient({ client: { getMessageById: async () => { throw new Error('store exploded'); } } }),
        // getMessageById throwing is swallowed by findMessage; force the 500 via resolveMedia.
        {
            getMessageById: async () => ({ id: { _serialized: MSG_ID }, hasMedia: true }),
            resolveMedia: async () => { throw new Error('store exploded'); }
        }
    );

    const res = await refetchResponse('1', { messageId: MSG_ID, chatId: CUST }, undefined, undefined, deps);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, error: 'store exploded' });
});
