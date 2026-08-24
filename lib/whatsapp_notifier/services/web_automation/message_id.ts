// Repairs the serialized WhatsApp message id, which current WhatsApp Web no
// longer hands across the puppeteer boundary.
//
// Every message model whatsapp-web.js emits is produced in-page by
// window.WWebJS.getMessageModel(msg) and then JSON-serialized on its way out
// (the Msg 'add' hook calls window.onAddMessageEvent, a page binding; bindings
// and page.evaluate both marshal by JSON). JSON only copies OWN ENUMERABLE
// properties, so a value that WhatsApp exposes as a prototype accessor is
// silently dropped. MsgKey._serialized is now exactly that: readable in-page,
// absent by the time the model reaches Node.
//
// The damage is not cosmetic — `id._serialized` is the message's only handle:
//   * Message#downloadMedia passes it into the page (Msg.get(msgId) →
//     Msg.getMessagesById([msgId])); with `undefined` the lookup throws, so
//     EVERY media message resolves "download_failed" and the host renders a
//     permanent "Media unavailable" bubble.
//   * normalizeInbound falls back to `${counterparty}-${timestamp}`, which is
//     not the id the host stored for its own /send, so the fromMe echo of our
//     own send can no longer be deduped — and two messages in the same second
//     on one chat collide onto a single fallback id.
//
// Two layers, because a page-side patch can be lost (a reload re-injects
// whatsapp-web.js's own WWebJS) and a Node-side rebuild depends on parts that
// may themselves stop crossing the boundary:
//   1. MESSAGE_MODEL_ID_PATCH — wraps getMessageModel IN THE PAGE, where the
//      accessor still works. Every emitted model gains a real, own
//      `_serialized` before it is marshalled. This is the primary fix.
//   2. ensureSerializedId — Node-side rebuild from the surviving key parts,
//      applied to each captured message. Covers the window before the patch
//      lands and any session where the patch could not be installed.

// The key as it survives the boundary. Everything is optional on purpose:
// this type describes damaged input, not the ideal shape.
export type MessageKey = {
    fromMe?: boolean;
    remote?: unknown;
    id?: string;
    participant?: unknown;
    _serialized?: string;
};

// WhatsApp's own serialization format, confirmed by whatsapp-web.js's parser
// in Client#getMessageById: 3 parts, or 4 when the message carries a
// participant (`fromMe_remote_id[_participant]`).
//
// Returns null unless every REQUIRED part is present — a partial id would be
// worse than none: it would look real, be accepted as a lookup key, and
// resolve to nothing.
export function buildSerializedId(key: MessageKey | null | undefined): string | null {
    if (!key) return null;
    const remote = widString(key.remote);
    const id = typeof key.id === 'string' ? key.id : '';
    if (!remote || !id) return null;

    const participant = widString(key.participant);
    const head = `${key.fromMe ? 'true' : 'false'}_${remote}_${id}`;
    return participant ? `${head}_${participant}` : head;
}

// `remote` and `participant` are Wid objects in-page. getMessageModel already
// flattens `remote` to its string form, but participant gets no such
// treatment, and a Wid that DID survive as an object still carries
// `_serialized` — so accept either shape.
function widString(wid: unknown): string {
    if (typeof wid === 'string') return wid;
    if (wid && typeof wid === 'object') {
        const serialized = (wid as { _serialized?: unknown })._serialized;
        if (typeof serialized === 'string') return serialized;
    }
    return '';
}

// Give one captured message a usable `id._serialized`, mutating it in place —
// whatsapp-web.js reads `this.id._serialized` off the very object we hold, so
// repairing a copy would fix our own bookkeeping and leave downloadMedia
// broken.
//
// Returns the serialized id (existing or rebuilt), or null when the key is too
// damaged to rebuild. Never throws: a capture path must not die on a malformed
// message.
export function ensureSerializedId(msg: { id?: MessageKey } | null | undefined): string | null {
    const key = msg && msg.id;
    if (!key) return null;
    if (typeof key._serialized === 'string' && key._serialized) return key._serialized;

    const rebuilt = buildSerializedId(key);
    if (rebuilt) key._serialized = rebuilt;
    return rebuilt;
}

// The page-side patch, as source to hand to page.evaluate.
//
// Idempotent (a flag on window), and it never replaces a working
// `_serialized` — the day WhatsApp puts the property back, this becomes a
// no-op wrapper instead of a competing implementation.
//
// In-page the accessor is readable, so the id is taken straight from the live
// MsgKey; the manual rebuild is only the last resort, and mirrors
// buildSerializedId above.
//
// Returns a short status string so the caller can log which happened.
export const MESSAGE_MODEL_ID_PATCH = `(() => {
    if (typeof window === 'undefined' || !window.WWebJS) return 'no-store';
    if (window.__waMessageIdPatch) return 'already-patched';
    const original = window.WWebJS.getMessageModel;
    if (typeof original !== 'function') return 'no-store';

    const widString = (wid) => {
        if (typeof wid === 'string') return wid;
        if (wid && typeof wid === 'object' && typeof wid._serialized === 'string') return wid._serialized;
        return '';
    };

    window.WWebJS.getMessageModel = function (message) {
        const model = original.apply(this, arguments);
        try {
            if (model && model.id && !model.id._serialized) {
                const key = message && message.id;
                let serialized = key && typeof key._serialized === 'string' ? key._serialized : '';
                if (!serialized && key && typeof key.toString === 'function') {
                    const asString = key.toString();
                    // toString() on a plain object yields "[object Object]" —
                    // a value that would pass a truthiness check and poison
                    // every id it is written to.
                    if (asString && asString.indexOf('[object') !== 0) serialized = asString;
                }
                if (!serialized && key) {
                    const remote = widString(key.remote);
                    const participant = widString(key.participant);
                    if (remote && typeof key.id === 'string' && key.id) {
                        serialized = (key.fromMe ? 'true' : 'false') + '_' + remote + '_' + key.id;
                        if (participant) serialized += '_' + participant;
                    }
                }
                if (serialized) model.id = Object.assign({}, model.id, { _serialized: serialized });
            }
        } catch (e) {
            // A model without its id still carries the message; never let the
            // repair itself break capture.
        }
        return model;
    };

    window.__waMessageIdPatch = true;
    return 'patched';
})()`;
