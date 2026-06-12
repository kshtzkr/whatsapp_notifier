// /send response helpers (pure, unit-testable — see send.test.ts).
//
// Kept separate from index.ts (which calls Bun.serve() at import time) so the
// wire shape can be tested without booting the server or whatsapp-web.js.

// The real WhatsApp id of a just-sent message, for the /send response. Hosts
// store it on their outbound record so the message_create echo of this very
// send (two-way capture replays our own messages too) dedupes on messageId
// instead of duplicating as an "operator app" bubble.
//
// Null — never a fabricated id — when the library hands nothing back: a
// made-up id matches no echo, yet would still occupy the host's unique
// message-id slot and block the echo from being adopted onto the right
// record.
export function sentMessageId(sent: any): string | null {
    return (sent && sent.id && sent.id._serialized) || null;
}
