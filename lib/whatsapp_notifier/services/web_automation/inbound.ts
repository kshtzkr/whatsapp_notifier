// Inbound capture core (v0.4.0; two-way since v0.8.0)
//
// Pure, testable logic for the two-way layer. Kept separate from index.ts so
// it can be unit-tested without booting a whatsapp-web.js Client.
//
// Policy: surface real 1:1 messages in BOTH directions (phone @c.us or
// privacy-id @lid) — customer replies AND messages the operator sends from
// the WhatsApp app itself (fromMe), so host threads show whole conversations.
// Groups (@g.us), status broadcasts, and non-text system events
// (e2e_notification, call_log, revoked, …) that carry no real reply are
// dropped. Captured messages buffer in an in-memory queue drained by GET
// /inbound/:userId (at-least-once; the host dedupes on messageId — which also
// eats the fromMe echo of its own /send calls — and decides relevance by
// matching the resolved phone to its own recipient records).

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
    // 0.8.0 two-way capture. Present ONLY on operator-sent messages (fromMe),
    // where `to` carries the counterparty (customer) chat id the host threads
    // on. Inbound payloads keep the exact pre-0.8.0 shape.
    fromMe?: boolean;
    to?: string;
    // 0.9.3. Present ONLY when the chat was keyed by a privacy id, carrying the
    // raw `<digits>@lid` the phone/counterparty above was resolved FROM. Hosts
    // that don't know the key ignore it; ours uses it to tell a resolved LID
    // chat apart from an ordinary phone chat when auditing a thread's origin.
    senderLid?: string;
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
// userId → (@lid privacy id → resolved phone @c.us). Learned whenever an @lid
// is resolved to a phone (inbound contact lookup, fromMe live lookup, history
// replay) and consulted by the fromMe leg, where msg.getContact() is no help
// (it resolves the SENDER — the operator). Persisted per user next to
// outbound_targets.json so a restart doesn't resume dropping operator
// messages until the customer happens to write again.
const lidAliases = new Map<string, Map<string, string>>();

// How to resolve a user's on-disk session dir. index.ts wires this to
// sessionDirForUser; tests point it at a tmp dir.
let baseDirResolver: (userId: string) => string = () => '.';
export function configureInbound(resolver: (userId: string) => string) {
    baseDirResolver = resolver;
}

function targetsFilePath(userId: string) {
    return join(baseDirResolver(userId), 'outbound_targets.json');
}

function aliasesFilePath(userId: string) {
    return join(baseDirResolver(userId), 'lid_aliases.json');
}

export function loadLidAliases(userId: string): Map<string, string> {
    const cached = lidAliases.get(userId);
    if (cached) return cached;

    const map = new Map<string, string>();
    try {
        const p = aliasesFilePath(userId);
        if (existsSync(p)) {
            const obj = JSON.parse(readFileSync(p, 'utf8'));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                for (const [lid, phone] of Object.entries(obj)) {
                    // Self-referential entries written by earlier versions
                    // (<lid> → <lid>@c.us) are dropped on the way in, so a
                    // service that has already been poisoned recovers on its
                    // next start instead of needing the file edited by hand.
                    // The purge reaches disk on the next rememberLidAlias
                    // write, which persists the whole map.
                    if (typeof phone === 'string' && isUsablePhoneFor(lid, phone)) map.set(lid, phone);
                }
            }
        }
    } catch (_) { /* corrupt/missing file → start empty */ }
    lidAliases.set(userId, map);
    return map;
}

export function resolveLidAlias(userId: string, lid: string): string | undefined {
    return loadLidAliases(userId).get(lid);
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

// The digits of a jid's user part, for comparing a privacy id against a
// candidate phone number.
export function jidDigits(jid: string): string {
    return String(jid || '').split('@')[0].replace(/\D/g, '');
}

// THE invariant of the whole @lid layer: a resolution is only usable when it
// is a phone chat id AND its digits are not simply the privacy id's own digits
// wearing a @c.us suffix.
//
// A @lid contact frequently reports `contact.id.user` (and sometimes
// `contact.number`) as the LID itself. Accepting that mints a phone number
// that has never existed: the host opens a thread keyed on it, no customer
// record can ever match, the operator sees an unreadable row of digits, and
// the alias map learns <lid> → <lid>@c.us — permanently routing the operator's
// own replies into that phantom thread. Every resolution path funnels through
// this check, so the class cannot come back one caller at a time.
export function isUsablePhoneFor(lid: string, resolved: string): boolean {
    if (!resolved || !resolved.endsWith('@c.us')) return false;
    const digits = jidDigits(resolved);
    return digits.length > 0 && digits !== jidDigits(lid);
}

// After an @lid is resolved to a phone @c.us, two things are remembered:
//
// 1. The @lid → phone mapping itself (persisted, see lidAliases): the fromMe
//    leg has no contact handle of its own, so without this map every operator
//    message in an @lid-keyed chat would depend on a live lookup succeeding.
// 2. If the resolved phone is one of our outbound targets, the @lid joins the
//    allowlist too. rememberTarget at send time only ever stores @c.us ids,
//    but for privacy-number accounts the *chat* is keyed by the @lid — so a
//    reconnect backfill that replays targets via chat-id lookup could never
//    re-open that chat, permanently losing any disconnect-window replies.
//    Duplicate captures across the @c.us/@lid pair are fine: the contract is
//    at-least-once and the host dedupes on messageId.
//
// A resolution that fails isUsablePhoneFor is never stored: a poisoned alias
// outlives the process (it is persisted) and would keep re-infecting every
// later message in the chat.
export function rememberLidAlias(userId: string, rawFrom: string, resolvedFrom: string) {
    if (!rawFrom.endsWith('@lid')) return;
    if (!isUsablePhoneFor(rawFrom, resolvedFrom)) return;
    const aliases = loadLidAliases(userId);
    if (aliases.get(rawFrom) !== resolvedFrom) {
        aliases.set(rawFrom, resolvedFrom);
        try {
            const dir = baseDirResolver(userId);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            writeFileSync(aliasesFilePath(userId), JSON.stringify(Object.fromEntries(aliases)));
        } catch (e) {
            console.error(`Failed to persist @lid alias for ${userId}`, e);
        }
    }
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

// ── Self-send echo registry ──
//
// Every POST /send fires its own fromMe message_create echo. Letting that
// echo run the capture pipeline is pure waste: a media send re-downloads the
// attachment it just uploaded (up to the 30s download budget on the sending
// Chromium) and stores bytes nobody will ever fetch against the per-user
// media cap — at campaign scale those phantom copies churn the cap, evicting
// REAL customer inbound media the operator still wants. The echo's payload is
// redundant too: the /send response already handed the host this exact
// messageId, and the host's id-dedupe would discard the echo anyway — so a
// registry hit is suppressed ENTIRELY (no media resolution, no enqueue, no
// webhook), which also closes the host-side echo-beats-response adopt race
// for same-process sends. Messages NOT in the registry (typed on the phone,
// or replayed by the reconnect backfill) flow through unchanged.
//
// Best-effort by design: the registry is in-memory, so an echo landing after
// a service restart (or one that fires before /send finishes registering the
// id) flows through — the host's id-dedupe catches it, harmless. Bounded per
// user and TTL'd because echoes land within seconds of the send; the limits
// only have to outlive the echo lag, not the conversation.
export const SELF_SEND_MAX = 200;
export const SELF_SEND_TTL_MS = 10 * 60 * 1000;

// userId → (messageId → expiry epoch ms). Maps iterate in insertion order,
// so the first key is always the oldest send — eviction is O(evicted).
const selfSendIds = new Map<string, Map<string, number>>();

export function rememberSelfSend(userId: string, messageId: string, nowMs = Date.now()) {
    let ids = selfSendIds.get(userId);
    if (!ids) { ids = new Map(); selfSendIds.set(userId, ids); }
    ids.set(messageId, nowMs + SELF_SEND_TTL_MS);
    while (ids.size > SELF_SEND_MAX) {
        ids.delete(ids.keys().next().value as string);
    }
}

export function isSelfSend(userId: string, messageId: string, nowMs = Date.now()): boolean {
    const ids = selfSendIds.get(userId);
    const expiry = ids && ids.get(messageId);
    if (expiry === undefined) return false;
    if (nowMs > expiry) {
        ids!.delete(messageId); // expired — forget it so the map stays lean
        return false;
    }
    return true;
}

// Sanity filter for a real 1:1 message in either direction. Accepts both
// phone-number chats (@c.us) and privacy-id chats (@lid — newer WhatsApp
// delivers replies from an @lid). The jid gate always validates the
// COUNTERPARTY: the customer is at `from` on inbound but at `to` on
// operator-sent (fromMe) messages — gating fromMe on `from` (the operator's
// own jid, always @c.us) would let group/status posts through. Groups
// (@g.us) and status (@broadcast) are dropped. The host app decides relevance
// by matching the resolved phone to its own records, so we no longer gate on
// the per-send allowlist (which was unreliable).
// Real human/content message types. Anything else (e2e_notification,
// notification_template, call_log, revoked, protocol, gp2, …) is a system event
// with no body and must NOT be surfaced as a reply.
const TEXTUAL_TYPES = new Set([
    'chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard'
]);

export function shouldCapture(userId: string, msg: any): boolean {
    if (!msg) return false;
    const counterparty: string = (msg.fromMe ? msg.to : msg.from) || '';
    if (!counterparty.endsWith('@c.us') && !counterparty.endsWith('@lid')) return false;
    if (msg.isStatus) return false;
    if (msg.type && !TEXTUAL_TYPES.has(msg.type)) return false; // drop system events
    return true;
}

export function normalizeInbound(msg: any, media?: InboundMediaInfo): InboundMsg {
    const from: string = msg.from || '';
    const to: string = msg.to || '';
    // The fallback id keys on the COUNTERPARTY (the customer): on fromMe the
    // `from` is the operator's own jid, shared by every chat — id-less
    // operator messages to different customers in the same second must not
    // collide in the host's dedupe.
    const counterparty = msg.fromMe ? to : from;
    const inbound: InboundMsg = {
        from,
        body: msg.body || '',
        messageId: (msg.id && msg.id._serialized) || `${counterparty}-${msg.timestamp}`,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        type: msg.type || 'chat'
    };
    // fromMe/to are added ONLY for operator-sent messages — like the media
    // keys below, inbound payloads keep the exact pre-0.8.0 shape so older
    // hosts stay byte-compatible and newer ones key-gate on fromMe presence.
    if (msg.fromMe) {
        inbound.fromMe = true;
        inbound.to = to;
    }
    // Media keys are added ONLY for media messages so text payloads keep the
    // exact 0.6.0 five-field shape (hosts key-gate on hasMedia presence).
    if (msg.hasMedia) inbound.hasMedia = true;
    if (media) Object.assign(inbound, media);
    return inbound;
}

// ── Capture pipeline ──
//
// Extracted from index.ts so the ordering contract is unit-testable:
// sanity filter → contact/@lid sender resolution (drop early) → media
// download → normalize → enqueue → optional webhook push. The media resolver
// is injected (media.ts's resolveMediaForMessage in production) so this file
// stays the dependency-free core.
export interface CaptureDeps {
    resolveMedia: (userId: string, msg: any) => Promise<InboundMediaInfo>;
    push?: (userId: string, msg: InboundMsg) => void;
}

export async function processInbound(userId: string, msg: any, deps: CaptureDeps) {
    if (!shouldCapture(userId, msg)) return;

    // Operator-sent messages take their own (shorter) path: no sender to
    // resolve, and the chat is keyed by the counterparty at msg.to.
    if (msg.fromMe) return processOwnMessage(userId, msg, deps);

    // One best-effort contact lookup feeds both the sender's display name
    // and the @lid phone resolution. Failure must never drop the message —
    // unless the sender is an unresolvable @lid (handled below).
    let contact: any;
    try {
        contact = await msg.getContact();
    } catch (e) {
        console.error(`contact lookup failed for ${userId}`, e);
    }

    // Resolve the sender BEFORE downloading media. Newer WhatsApp delivers
    // the reply's `from` as an @lid privacy id with no phone number, which
    // the host can't match; if no phone can be recovered the message is
    // dropped — and a dropped message must not have cost a download that
    // leaves up to 25MB of unreferenced bytes on disk.
    const rawFrom: string = msg.from || '';
    let from = rawFrom;
    if (rawFrom.endsWith('@lid')) {
        const resolved = await resolveLidToPhone(userId, rawFrom, msg.client, contact);
        // No phone behind the privacy id => nothing to match or scope by.
        // Drop it rather than forward an unmatchable counterparty — or, worse,
        // the privacy id's own digits dressed up as a phone number.
        if (!resolved) {
            console.log(`Dropping inbound message from unresolved @lid chat for ${userId}`);
            return;
        }
        from = resolved;
    }

    // Only a kept message earns the download. Every resolver failure mode
    // returns an 'unavailable' verdict instead of throwing, so the message
    // still reaches the host type-only.
    let media: InboundMediaInfo | undefined;
    if (msg.hasMedia) {
        media = await deps.resolveMedia(userId, msg);
    }

    const inbound = normalizeInbound(msg, media);
    inbound.from = from;
    const senderName = contact && (contact.pushname || contact.name || contact.shortName);
    if (senderName) inbound.senderName = String(senderName);
    if (rawFrom.endsWith('@lid')) {
        // Known recipient replying from a privacy-number chat: allowlist the
        // @lid chat id too, so the reconnect backfill can re-open this chat.
        // (resolveLidToPhone already learned the alias; this is the allowlist
        // half, and re-learning an identical mapping is a no-op.)
        rememberLidAlias(userId, rawFrom, from);
        inbound.senderLid = rawFrom;
    }

    enqueueInbound(userId, inbound);
    if (deps.push) deps.push(userId, inbound);
}

// Operator-sent (fromMe) leg of the pipeline. The senderName contact lookup
// is skipped on purpose: the "sender" is the operator themself, so the name
// adds nothing and the lookup costs a puppeteer roundtrip per message. Media
// resolution, enqueue and webhook are the SAME as inbound — operator photos/
// documents sync through the existing GET /media path under the same caps.
async function processOwnMessage(userId: string, msg: any, deps: CaptureDeps) {
    // The echo of our own /send: suppress entirely — no media resolution, no
    // enqueue, no webhook (see the self-send registry above for why).
    // rememberTarget is skipped too: /send already allowlisted this recipient.
    const messageId = msg.id && msg.id._serialized;
    if (messageId && isSelfSend(userId, messageId)) return;

    const rawTo: string = msg.to || '';
    let to = rawTo;
    // An @lid counterparty carries no phone number the host can thread on,
    // and msg.getContact() is no help here (it resolves the SENDER — the
    // operator). Newer WhatsApp keys some 1:1 chats by the @lid, so EVERY
    // operator-phone message in such a chat used to hit an unconditional
    // drop while the customer's side flowed — half the conversation lost.
    // Resolve it instead, BEFORE any media download (a dropped message must
    // not have cost one), through the same resolver the inbound leg uses.
    // Only when every path fails is the message dropped — the rare case, not
    // every @lid-keyed chat.
    if (rawTo.endsWith('@lid')) {
        const resolved = await resolveLidToPhone(userId, rawTo, msg.client);
        if (!resolved) {
            console.log(`Dropping fromMe message to unresolved @lid chat for ${userId}`);
            return;
        }
        to = resolved;
    }

    // Same kept-message-earns-the-download rule as inbound: every resolver
    // failure mode reports 'unavailable' instead of throwing.
    let media: InboundMediaInfo | undefined;
    if (msg.hasMedia) {
        media = await deps.resolveMedia(userId, msg);
    }

    const inbound = normalizeInbound(msg, media);
    // Thread on the resolved phone: the host matches `to` against its own
    // recipient records, and a raw @lid would never match. The @lid is still
    // fine as normalizeInbound's fallback-id key — any stable counterparty
    // string dedupes correctly.
    inbound.to = to;

    // A fromMe message to a brand-new number means the operator opened the
    // conversation in the WhatsApp app — allowlist the chat exactly like
    // /send does for its recipients, so the reconnect backfill can replay
    // this conversation after a disconnect window too. For an @lid-keyed
    // chat the alias call ALSO allowlists the @lid id itself — the id the
    // chat is actually reachable by (see rememberLidAlias).
    rememberTarget(userId, to);
    if (rawTo.endsWith('@lid')) {
        rememberLidAlias(userId, rawTo, to);
        inbound.senderLid = rawTo;
    }

    enqueueInbound(userId, inbound);
    if (deps.push) deps.push(userId, inbound);
}

// A contact's phone chat id, or null. contact.number is the contact's own
// phone; contact.id.user is trusted ONLY when the contact id is itself
// phone-keyed, because for an @lid contact that field IS the privacy id.
// Both answers still face isUsablePhoneFor at the call site.
function phoneFromContact(contact: any): string | null {
    if (!contact) return null;
    const serialized = String((contact.id && contact.id._serialized) || '');
    const num = contact.number ||
        (serialized.endsWith('@c.us') && contact.id && contact.id.user);
    const digits = num ? String(num).replace(/\D/g, '') : '';
    return digits ? `${digits}@c.us` : null;
}

// One live lookup of the phone behind a privacy id, newest API first:
//
//   getContactLidAndPhone  — whatsapp-web.js 1.34.7's purpose-built LID↔PN
//                            resolver (WWebJS.enforceLidAndPnRetrieval). This
//                            is the authoritative answer and the reason a
//                            phone can now be recovered even when the contact
//                            object carries nothing but the LID.
//   getContactById         — the older path, kept as the fallback for a client
//                            that predates the API or returns no mapping.
//
// Every failure is swallowed: a lookup that cannot answer must degrade to
// "unresolved" (the message is then dropped), never throw into the pipeline.
async function lookupPhoneForLid(client: any, lid: string): Promise<string | null> {
    if (!client) return null;

    if (typeof client.getContactLidAndPhone === 'function') {
        try {
            const rows = await client.getContactLidAndPhone([ lid ]);
            const pn = Array.isArray(rows) && rows[0] && rows[0].pn;
            const digits = jidDigits(String(pn || ''));
            if (digits) return `${digits}@c.us`;
        } catch (e) {
            console.error(`getContactLidAndPhone failed for ${lid}`, e);
        }
    }

    if (typeof client.getContactById === 'function') {
        try {
            return phoneFromContact(await client.getContactById(lid));
        } catch (e) {
            console.error(`@lid contact lookup failed for ${lid}`, e);
        }
    }

    return null;
}

// THE single @lid → phone resolver, shared by the inbound leg, the operator
// (fromMe) leg and history replay. It exists because those three grew separate
// copies and they drifted: the fromMe copy guarded against trusting an @lid
// contact id, the inbound copy did not, and so every privacy-keyed chat that
// arrived customer-first was threaded onto a fabricated phone number.
//
// Order is cheapest-and-most-trusted first:
//   1. the learned alias map — free, already proven for this chat;
//   2. the contact object the caller already fetched — free, no extra roundtrip;
//   3. one live lookup — a puppeteer roundtrip, so last.
//
// Anything that survives isUsablePhoneFor is learned for next time. A null
// return means "no phone behind this privacy id", and every caller drops the
// message rather than forward a counterparty the host can never match.
export async function resolveLidToPhone(
    userId: string,
    lid: string,
    client?: any,
    contact?: any
): Promise<string | null> {
    const learned = resolveLidAlias(userId, lid);
    if (learned && isUsablePhoneFor(lid, learned)) return learned;

    const fromContact = phoneFromContact(contact);
    if (fromContact && isUsablePhoneFor(lid, fromContact)) {
        rememberLidAlias(userId, lid, fromContact);
        return fromContact;
    }

    const looked = await lookupPhoneForLid(client, lid);
    if (looked && isUsablePhoneFor(lid, looked)) {
        rememberLidAlias(userId, lid, looked);
        return looked;
    }

    return null;
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
    // Same resurrection hazard as the allowlist: the on-disk lid_aliases.json
    // was just wiped with the session dir, and a re-pair (possibly a DIFFERENT
    // WhatsApp number) must not inherit the old pairing's @lid mappings.
    lidAliases.delete(userId);
    // Self-send echo ids belong to the old pairing too — and suppression must
    // never leak across a re-pair (however unlikely an id collision is).
    selfSendIds.delete(userId);
}

// Test helper: wipe in-memory state between examples.
export function resetInboundState() {
    inboundQueues.clear();
    outboundTargets.clear();
    lidAliases.clear();
    selfSendIds.clear();
}
