// Inbound capture core (v0.4.0)
//
// Pure, testable logic for the two-way layer. Kept separate from index.ts so
// it can be unit-tested without booting a whatsapp-web.js Client.
//
// Policy: surface ONLY replies from people this user messaged first. Every
// /send records the recipient in a per-user allowlist (persisted to disk so it
// survives restarts). The 'message' handler drops anything not on the allowlist
// — plus groups (@g.us), status broadcasts, and our own messages. Captured
// messages buffer in an in-memory queue drained by GET /inbound/:userId
// (at-least-once delivery; the Rails side dedupes on messageId).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface InboundMsg {
    from: string;
    body: string;
    messageId: string;
    timestamp: number;
    type: string;
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
export function shouldCapture(userId: string, msg: any): boolean {
    if (!msg || msg.fromMe) return false;
    const from: string = msg.from || '';
    if (!from.endsWith('@c.us') && !from.endsWith('@lid')) return false;
    if (msg.isStatus) return false;
    return true;
}

export function normalizeInbound(msg: any): InboundMsg {
    const from: string = msg.from || '';
    return {
        from,
        body: msg.body || '',
        messageId: (msg.id && msg.id._serialized) || `${from}-${msg.timestamp}`,
        timestamp: msg.timestamp || Math.floor(Date.now() / 1000),
        type: msg.type || 'chat'
    };
}

// Test helper: wipe in-memory state between examples.
export function resetInboundState() {
    inboundQueues.clear();
    outboundTargets.clear();
}
