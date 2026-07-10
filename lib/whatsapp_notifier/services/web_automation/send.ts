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

// Validation for the POST /send body. `to` is always required; the payload
// must additionally carry SOMETHING deliverable — a text message, a media
// URL, or both.
//
// The old `!to || !message` check 422'd every caption-less file: hosts that
// attach files one-by-one put the caption only on the FIRST file, so files
// 2..n of a batch (and any file sent without a caption) arrive as
// message "" + mediaUrl and were rejected.
//
// Returns the 422 error string, or null when the body is valid.
export function sendValidationError(body: { to?: unknown; message?: unknown; mediaUrl?: unknown }): string | null {
    if (!body.to || (!body.message && !body.mediaUrl)) {
        return '`to` and one of `message`/`mediaUrl` are required';
    }
    return null;
}

// sendMessage options for a media send: caption only when there IS one. A
// caption-less file arrives with message "" — omitting the key entirely
// matches a hand-sent file instead of attaching an empty caption.
export function captionOptions(message?: string | null): { caption?: string } {
    return message ? { caption: message } : {};
}
