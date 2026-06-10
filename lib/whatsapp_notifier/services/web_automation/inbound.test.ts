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
    shouldCapture,
    normalizeInbound,
    resetInboundState,
    type ChatResolver
} from './inbound';

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
