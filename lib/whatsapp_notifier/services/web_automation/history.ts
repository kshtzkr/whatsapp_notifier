// Chat-history endpoints core (v0.8.0)
//
// Pure, testable logic behind GET /chats/:userId (discovery: which 1:1
// conversations exist on the paired number) and POST /history/:userId
// (replay one chat's recent messages so the host can sync conversations
// that predate the pairing). Kept separate from index.ts (which calls
// Bun.serve() at import time) so the gating, validation and response
// contracts can be unit-tested without booting the server or
// whatsapp-web.js — same seam pattern as media.ts / send.ts.

import {
    InboundMsg,
    InboundMediaInfo,
    ChatLike,
    shouldCapture,
    normalizeInbound
} from './inbound';
import { verifyMediaToken, MediaResolution, sanitizeId } from './media';

// ── Chat list (GET /chats) ──

export interface ChatSummary {
    id: string;
    name: string | null;
    lastMessageAt: number | null; // epoch seconds; null when the chat carries none
}

// Discovery cap. getChats() on a long-lived personal number can return
// thousands of chats; serializing them all on every discovery call bloats the
// response and stalls the session, while the host only needs the recent
// conversations to offer for syncing — the newest 500 is far more than any
// operator will ever scroll through.
export const CHAT_LIST_CAP = 500;

// Reduce whatsapp-web.js Chat objects to the discovery wire shape: 1:1 chats
// ONLY (ids ending @c.us — groups @g.us, status @broadcast and @lid privacy
// chats are excluded; the last two carry nothing the host can thread on and
// groups are never captured), name best-effort, newest first, capped.
export function summarizeChats(chats: any[]): ChatSummary[] {
    return (Array.isArray(chats) ? chats : [])
        .filter((chat) =>
            typeof chat?.id?._serialized === 'string' && chat.id._serialized.endsWith('@c.us'))
        .map((chat) => ({
            id: chat.id._serialized,
            name: typeof chat.name === 'string' && chat.name ? chat.name : null,
            lastMessageAt: Number.isFinite(chat.timestamp) ? chat.timestamp : null
        }))
        .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
        .slice(0, CHAT_LIST_CAP);
}

// ── History replay (POST /history) ──

export const DEFAULT_HISTORY_LIMIT = 50;
export const MAX_HISTORY_LIMIT = 200;

// Clamp the requested message count to 1..200 (default 50). fetchMessages
// hydrates every message through puppeteer, so an unbounded limit could stall
// the session for minutes on one request; non-numeric garbage falls back to
// the default rather than erroring (the host's knob, not a contract field).
export function clampHistoryLimit(raw: unknown): number {
    if (raw === undefined || raw === null) return DEFAULT_HISTORY_LIMIT;
    const parsed = Math.floor(Number(raw));
    if (!Number.isFinite(parsed)) return DEFAULT_HISTORY_LIMIT;
    return Math.min(Math.max(parsed, 1), MAX_HISTORY_LIMIT);
}

// Mirror /send's `${digits}@c.us` normalization (a bare phone number gets the
// @c.us suffix appended), then REQUIRE the result to be a 1:1 @c.us id.
// History is 1:1-only by contract, and unlike /send the suffix is appended
// only to suffix-less input: blindly appending to "...@g.us" / "...@lid"
// would mint a never-resolvable franken-id that sails past the gate.
export function normalizeHistoryChatId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const chatId = trimmed.includes('@') ? trimmed : `${trimmed}@c.us`;
    return chatId.endsWith('@c.us') ? chatId : null;
}

// Media in history is marked, never downloaded: a 200-message replay of a
// photo-heavy chat would pull hundreds of MB in a single request — blowing
// the media disk caps and stalling the session behind sequential puppeteer
// downloads. The host receives hasMedia plus this verdict (mediaError
// 'history' tells it apart from a failed live download) and live capture
// keeps downloading media for everything that arrives going forward.
export const HISTORY_MEDIA_ERROR = 'history';

export function historyMediaInfo(): InboundMediaInfo {
    return { mediaStatus: 'unavailable', mediaError: HISTORY_MEDIA_ERROR };
}

// Replay one chat's recent messages through the live-capture normalizer.
// BOTH directions survive — fetchMessages returns operator (fromMe) messages
// too, and normalizeInbound adds fromMe/to exactly like live capture, so the
// host threads whole conversations. Messages failing shouldCapture (system
// events, status, group posts) are skipped. Returned oldest-first so the
// host can ingest in thread order.
export async function replayHistory(userId: string, chat: ChatLike, limit: number): Promise<InboundMsg[]> {
    const msgs = await chat.fetchMessages({ limit });
    return (Array.isArray(msgs) ? msgs : [])
        .filter((m) => shouldCapture(userId, m))
        .map((m) => normalizeInbound(m, m.hasMedia ? historyMediaInfo() : undefined))
        .sort((a, b) => a.timestamp - b.timestamp);
}

// ── Route responses ──
//
// Full Response builders (same pattern as media.ts) so index.ts stays
// glue-only. The deps seam injects index.ts's pairing fast-reject and client
// accessor: both routes mirror /send EXACTLY — reject a never-paired user
// BEFORE any client exists (so the route can never boot a Chromium that
// parks in QR_REQUIRED forever), then getOrCreateClient (never any other
// initialization path), then require AUTHENTICATED + ready. On top of /send's
// gate they also enforce X-WA-Token (same helper as /media) when the service
// has WHATSAPP_WEBHOOK_TOKEN set: these routes expose whole conversations,
// not just the caller's own queue.

export interface GatedClient {
    state: string;
    ready?: boolean;
    lastUsed: number;
    client: any;
}

export interface SessionGateDeps {
    hasPaired: (userId: string) => boolean;
    getClient: (userId: string) => Promise<GatedClient>;
}

export interface HistoryDeps extends SessionGateDeps {
    resolveChat: (client: any, chatId: string) => Promise<ChatLike | null>;
    rememberTarget: (userId: string, chatId: string) => void;
}

function deny(status: number, error: string): Response {
    return Response.json({ success: false, error }, { status });
}

// Paired + ready gate shared by both routes — returns the live client data,
// or the 401 Response the route must answer with.
async function gatePairedReady(userId: string, deps: SessionGateDeps): Promise<GatedClient | Response> {
    if (!deps.hasPaired(userId)) {
        return deny(401, 'No saved WhatsApp session for this user — pair via QR first');
    }
    const data = await deps.getClient(userId);
    if (data.state !== 'AUTHENTICATED' || !data.ready) {
        return deny(401, 'User not authenticated');
    }
    return data;
}

export async function chatsResponse(
    userId: string,
    token: string | undefined,
    expectedToken: string | undefined,
    deps: SessionGateDeps
): Promise<Response> {
    if (!verifyMediaToken(token, expectedToken)) return deny(401, 'unauthorized');
    const gate = await gatePairedReady(userId, deps);
    if (gate instanceof Response) return gate;

    try {
        const chats = await gate.client.getChats();
        gate.lastUsed = Date.now();
        return Response.json({ success: true, chats: summarizeChats(chats) });
    } catch (error: any) {
        console.error(`Chat list error for user ${userId}:`, error);
        return deny(500, (error && error.message) || String(error));
    }
}

export async function historyResponse(
    userId: string,
    body: any,
    token: string | undefined,
    expectedToken: string | undefined,
    deps: HistoryDeps
): Promise<Response> {
    if (!verifyMediaToken(token, expectedToken)) return deny(401, 'unauthorized');
    // Validate the body before the pairing gate, mirroring /send's ordering
    // (a malformed request earns its 422 without touching any client).
    const chatId = normalizeHistoryChatId(body && body.chatId);
    if (!chatId) {
        return deny(422, '`chatId` is required and must be a 1:1 @c.us chat id');
    }
    const gate = await gatePairedReady(userId, deps);
    if (gate instanceof Response) return gate;

    try {
        // Same resolver seam the reconnect backfill uses (getChatById with the
        // contact fallback) — null means the chat never materialized.
        const chat = await deps.resolveChat(gate.client, chatId);
        if (!chat) return deny(404, 'chat not found');

        const messages = await replayHistory(userId, chat, clampHistoryLimit(body && body.limit));

        // A synced chat is a conversation of record: allowlist it like a /send
        // recipient so disconnect-window replies to it backfill on reconnect.
        deps.rememberTarget(userId, chatId);
        gate.lastUsed = Date.now();
        // Returned DIRECTLY — no queue, no webhook. The host ingests the
        // response synchronously; queueing a bulk replay would interleave it
        // with (and delay) live traffic in the /inbound drain.
        return Response.json({ success: true, messages });
    } catch (error: any) {
        console.error(`History replay error for user ${userId}:`, error);
        return deny(500, (error && error.message) || String(error));
    }
}

// ── On-demand media re-download (POST /media/:userId/refetch) ──
//
// WhatsApp's tap-to-download model. Eager capture only keeps RECENT media
// (the per-user rolling cap rolls old media off; the TTL sweep expires media
// past 48h) so an operator opening an old or evicted media bubble finds the
// service has no copy (GET /media 404s). This endpoint re-pulls THAT one
// message's bytes on demand: resolve the message upstream, download it
// (respecting the SAME per-message size cap + 30s timeout as live capture),
// store it (the write re-enforces the per-user cap), and report it ready so
// the host can GET /media as usual. A message whose media is gone upstream
// (deleted, too old) answers a 404 'gone' so the host can grey the bubble out.

export interface RefetchDeps extends SessionGateDeps {
    // getMessageById is the fast path; resolveChat + a fetchMessages scan is
    // the fallback for ids getMessageById can't hydrate directly.
    getMessageById: (client: any, messageId: string) => Promise<any | null>;
    resolveChat: (client: any, chatId: string) => Promise<ChatLike | null>;
    // Injected media.ts pipeline (download → cap-enforced store → verdict),
    // seamed so the route can be tested without a real downloadMedia.
    resolveMedia: (userId: string, msg: any) => Promise<MediaResolution>;
}

// Find the live whatsapp-web.js Message for an id: getMessageById first, then
// scan the chat's recent messages for a matching serialized id. Returns null
// when neither path turns it up (message rolled out of the chat window, or the
// id is unknown) — the route maps that to 'gone'.
export async function findMessage(
    deps: RefetchDeps,
    client: any,
    messageId: string,
    chatId: string
): Promise<any | null> {
    try {
        const direct = await deps.getMessageById(client, messageId);
        if (direct) return direct;
    } catch (_) { /* fall through to the chat scan */ }

    try {
        const chat = await deps.resolveChat(client, chatId);
        if (!chat) return null;
        const msgs = await chat.fetchMessages({ limit: MAX_HISTORY_LIMIT });
        return (Array.isArray(msgs) ? msgs : [])
            .find((m) => m && m.id && m.id._serialized === messageId) || null;
    } catch (_) {
        return null;
    }
}

// Re-download the bytes for one message. Same token gate, paired+ready gate
// and @c.us-validated chatId as /history; the messageId must sanitize to the
// store charset (the path the host will GET it back on). On success answers
// { success: true, mediaStatus: 'available', media* }; when the media no
// longer exists upstream answers 404 { success: false, mediaStatus:
// 'unavailable', mediaError: 'gone' }.
export async function refetchResponse(
    userId: string,
    body: any,
    token: string | undefined,
    expectedToken: string | undefined,
    deps: RefetchDeps
): Promise<Response> {
    if (!verifyMediaToken(token, expectedToken)) return deny(401, 'unauthorized');
    // Validate the body before the pairing gate (mirrors /history): a malformed
    // request earns its 422 without touching any client.
    const messageId = sanitizeId(body && body.messageId);
    if (!messageId) {
        return deny(422, '`messageId` is required');
    }
    const chatId = normalizeHistoryChatId(body && body.chatId);
    if (!chatId) {
        return deny(422, '`chatId` is required and must be a 1:1 @c.us chat id');
    }
    const gate = await gatePairedReady(userId, deps);
    if (gate instanceof Response) return gate;

    try {
        const msg = await findMessage(deps, gate.client, messageId, chatId);
        gate.lastUsed = Date.now();
        // Message not found upstream, or found but carries no media → nothing
        // to re-download. Same 'gone' verdict either way: the bytes are gone.
        if (!msg || !msg.hasMedia) {
            return Response.json(
                { success: false, mediaStatus: 'unavailable', mediaError: 'gone' },
                { status: 404 }
            );
        }

        // resolveMediaForMessage downloads (per-message cap + 30s timeout) and
        // stores under the SAME id the host GETs, re-enforcing the per-user cap.
        const verdict = await deps.resolveMedia(userId, msg);
        if (verdict.mediaStatus !== 'available') {
            // expired (gone upstream), too_large, download_failed, … → the host
            // can't show bytes. 404 with the typed reason so it greys the bubble.
            return Response.json(
                { success: false, mediaStatus: 'unavailable', mediaError: verdict.mediaError || 'gone' },
                { status: 404 }
            );
        }

        return Response.json({
            success: true,
            messageId,
            mediaStatus: 'available',
            mediaMime: verdict.mediaMime,
            ...(verdict.mediaFilename ? { mediaFilename: verdict.mediaFilename } : {}),
            mediaSize: verdict.mediaSize
        });
    } catch (error: any) {
        console.error(`Media refetch error for user ${userId}:`, error);
        return deny(500, (error && error.message) || String(error));
    }
}
