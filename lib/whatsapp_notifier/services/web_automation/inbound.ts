// Inbound capture core (v0.4.0)
//
// Pure, testable logic for the two-way layer. Kept separate from index.ts so
// it can be unit-tested without booting a whatsapp-web.js Client.
//
// Policy: surface real inbound 1:1 messages (phone @c.us or privacy-id @lid)
// — dropping our own messages, groups (@g.us), status broadcasts, and non-text
// system events (e2e_notification, call_log, revoked, …) that carry no real
// reply. Captured messages buffer in an in-memory queue drained by GET
// /inbound/:userId (at-least-once; the host dedupes on messageId and decides
// relevance by matching the resolved phone to its own recipient records).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface InboundMsg {
    from: string;
    body: string;
    messageId: string;
    timestamp: number;
    type: string;
    // 0.7.0 media + sender enrichment. ALL optional and only present when the
    // message actually carries them, so the wire format stays byte-compatible
    // with 0.6.0 hosts (and 0.7.0 hosts can key-gate on hasMedia).
    hasMedia?: boolean;
    mediaStatus?: 'available' | 'unavailable';
    mediaError?: string;
    mediaMime?: string;
    mediaFilename?: string;
    mediaSize?: number;
    senderName?: string;
}

// Media verdict merged into the payload by captureInbound — structurally
// matches media.ts's MediaResolution without importing it (inbound stays the
// dependency-free core).
export interface InboundMediaInfo {
    mediaStatus: 'available' | 'unavailable';
    mediaError?: string;
    mediaMime?: string;
    mediaFilename?: string;
    mediaSize?: number;
}

export const INBOUND_QUEUE_CAP = 1000;

const inboundQueues = new Map<string, InboundMsg[]>();
const outboundTargets = new Map<string, Set<string>>();

// How to resolve a user's on-disk session dir. index.ts wires this to
// sessionDirForUser; tests point it at a tmp dir.
let baseDirResolver: (userId: string) => string = () => '.';
export function configureInbound(resolver: (userId: string) => string) {
    baseDirResolver = resolver;
}

function targetsFilePath(userId: string) {
    return join(baseDirResolver(userId), 'outbound_targets.json');
}

export function loadTargets(userId: string): Set<string> {
    const cached = outboundTargets.get(userId);
    if (cached) return cached;

    let set = new Set<string>();
    try {
        const p = targetsFilePath(userId);
        if (existsSync(p)) {
            const arr = JSON.parse(readFileSync(p, 'utf8'));
            if (Array.isArray(arr)) set = new Set(arr);
        }
    } catch (_) { /* corrupt/missing file → start empty */ }
    outboundTargets.set(userId, set);
    return set;
}

// After an @lid sender is resolved to a phone @c.us: if the resolved phone is
// one of our outbound targets, remember the @lid alias too. rememberTarget at
// send time only ever stores @c.us ids, but for privacy-number accounts the
// *chat* is keyed by the @lid — so a reconnect backfill that replays targets
// via chat-id lookup could never re-open that chat, permanently losing any
// disconnect-window replies. Duplicate captures across the @c.us/@lid pair are
// fine: the contract is at-least-once and the host dedupes on messageId.
export function rememberLidAlias(userId: string, rawFrom: string, resolvedFrom: string) {
    if (!rawFrom.endsWith('@lid')) return;
    if (loadTargets(userId).has(resolvedFrom)) rememberTarget(userId, rawFrom);
}

export function rememberTarget(userId: string, chatId: string) {
    const set = loadTargets(userId);
    if (set.has(chatId)) return;
    set.add(chatId);
    try {
        const dir = baseDirResolver(userId);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(targetsFilePath(userId), JSON.stringify([...set]));
    } catch (e) {
        console.error(`Failed to persist outbound target for ${userId}`, e);
    }
}

export function enqueueInbound(userId: string, msg: InboundMsg) {
    let q = inboundQueues.get(userId);
    if (!q) { q = []; inboundQueues.set(userId, q); }
    q.push(msg);
    // Bound memory: drop oldest beyond the cap.
    if (q.length > INBOUND_QUEUE_CAP) q.splice(0, q.length - INBOUND_QUEUE_CAP);
}

export function drainInbound(userId: string): InboundMsg[] {
    const q = inboundQueues.get(userId) || [];
    inboundQueues.set(userId, []);
    return q;
}

// Sanity filter for a real inbound 1:1 reply. Accepts both phone-number chats
// (@c.us) and privacy-id chats (@lid — newer WhatsApp delivers replies from an
// @lid). Drops own messages, groups (@g.us) and status (@broadcast). The host
// app decides relevance by matching the resolved phone to its own records, so
// we no longer gate on the per-send allowlist (which was unreliable).
// Real human/content message types. Anything else (e2e_notification,
// notification_template, call_log, revoked, protocol, gp2, …) is a system event
// with no body and must NOT be surfaced as a reply.
const TEXTUAL_TYPES = new Set([
    'chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard'
]);

export function shouldCapture(userId: string, msg: any): boolean {
    if (!msg || msg.fromMe) return false;
    const from: string = msg.from || '';
    if (!from.endsWith('@c.us') && !from.endsWith('@lid')) return false;
    if (msg.isStatus) return false;
    if (msg.type && !TEXTUAL_TYPES.has(msg.type)) return false; // drop system events
    return true;
}

export function normalizeInbound(msg: any, media?: InboundMediaInfo): InboundMsg {
    const from: string = msg.from || '';
    const inbound: InboundMsg = {
        from,
        body: msg.body || '',
        messageId: (msg.id && msg.id._serialized) || `${from}-${msg.timestamp}`,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        type: msg.type || 'chat'
    };
    // Media keys are added ONLY for media messages so text payloads keep the
    // exact 0.6.0 five-field shape (hosts key-gate on hasMedia presence).
    if (msg.hasMedia) inbound.hasMedia = true;
    if (media) Object.assign(inbound, media);
    return inbound;
}

// Minimal slice of whatsapp-web.js Client that backfill needs — a seam so the
// replay loop can be tested without booting a real client.
export interface ChatLike {
    fetchMessages(opts: { limit: number }): Promise<any[]>;
}

export interface ChatResolver {
    getChatById(chatId: string): Promise<ChatLike>;
    getContactById(chatId: string): Promise<{ getChat(): Promise<ChatLike> }>;
}

// Resolve a target chat id, falling back to the contact: @lid-keyed chats are
// sometimes only reachable via getContactById(...).getChat() while a plain
// getChatById throws. Returns null when neither works (chat not materialized).
export async function resolveChat(client: ChatResolver, chatId: string): Promise<ChatLike | null> {
    try {
        return await client.getChatById(chatId);
    } catch (_) { /* fall through to the contact lookup */ }
    try {
        const contact = await client.getContactById(chatId);
        return await contact.getChat();
    } catch (_) {
        return null;
    }
}

// Replay recent messages from every remembered outbound target through
// `capture`. Per-chat failures skip that chat only, so one stale target can't
// abort recovery for the rest.
export async function backfillTargets(
    userId: string,
    client: ChatResolver,
    capture: (userId: string, msg: any) => void | Promise<void>,
    limit = 20
) {
    for (const chatId of loadTargets(userId)) {
        try {
            const chat = await resolveChat(client, chatId);
            if (!chat) continue;
            const msgs = await chat.fetchMessages({ limit });
            for (const m of msgs) await capture(userId, m);
        } catch (_) { /* keep replaying the other chats */ }
    }
}

// Forget one user's buffered inbound + cached target allowlist. POST /logout
// calls this after wiping the session dir: messages captured between the last
// poll and the logout belong to the OLD pairing, and the gated GET /inbound
// (unpaired → [] without draining) would otherwise hold them in memory until
// the same userId re-pairs — then replay them into the WRONG pairing. The
// allowlist cache must go too, or loadTargets would resurrect targets whose
// on-disk file the logout just deleted.
export function clearInbound(userId: string) {
    inboundQueues.delete(userId);
    outboundTargets.delete(userId);
}

// Test helper: wipe in-memory state between examples.
export function resetInboundState() {
    inboundQueues.clear();
    outboundTargets.clear();
}
