import { test, expect } from 'bun:test';
import { buildSerializedId, ensureSerializedId, MESSAGE_MODEL_ID_PATCH } from './message_id';

// ── buildSerializedId ──
//
// The format is WhatsApp's own, and whatsapp-web.js parses it back apart in
// Client#getMessageById: `fromMe_remote_id`, plus `_participant` when there
// is one.
test('buildSerializedId rebuilds the three-part id', () => {
    expect(buildSerializedId({ fromMe: false, remote: '919999000001@c.us', id: 'ABC123' }))
        .toBe('false_919999000001@c.us_ABC123');
    expect(buildSerializedId({ fromMe: true, remote: '919999000001@c.us', id: 'ABC123' }))
        .toBe('true_919999000001@c.us_ABC123');
});

test('buildSerializedId appends the participant as a fourth part', () => {
    expect(buildSerializedId({
        fromMe: false, remote: '12036@g.us', id: 'ABC123', participant: '919999000001@c.us'
    })).toBe('false_12036@g.us_ABC123_919999000001@c.us');
});

// getMessageModel flattens `remote` to a string, but a Wid object still
// reaches us in other shapes (and participant is never flattened) — accept
// both rather than silently producing "[object Object]" in an id.
test('buildSerializedId accepts Wid objects for remote and participant', () => {
    expect(buildSerializedId({
        fromMe: false,
        remote: { _serialized: '919999000001@c.us' },
        id: 'ABC123',
        participant: { _serialized: '919999000002@c.us' }
    })).toBe('false_919999000001@c.us_ABC123_919999000002@c.us');
});

// A partial id is worse than none: it looks real, gets accepted as a lookup
// key, and resolves to nothing.
test('buildSerializedId returns null when a required part is missing', () => {
    expect(buildSerializedId(null)).toBeNull();
    expect(buildSerializedId(undefined)).toBeNull();
    expect(buildSerializedId({})).toBeNull();
    expect(buildSerializedId({ fromMe: false, id: 'ABC123' })).toBeNull();            // no remote
    expect(buildSerializedId({ fromMe: false, remote: '919999000001@c.us' })).toBeNull(); // no id
    expect(buildSerializedId({ fromMe: false, remote: {}, id: 'ABC' })).toBeNull();   // unusable Wid
    expect(buildSerializedId({ fromMe: false, remote: '919999000001@c.us', id: '' })).toBeNull();
});

// ── ensureSerializedId ──
//
// It MUTATES the message: whatsapp-web.js reads `this.id._serialized` off the
// very object we hold (Message#downloadMedia passes it into the page), so
// repairing a copy would fix our own bookkeeping and leave media broken.
test('ensureSerializedId writes the rebuilt id back onto the message', () => {
    const msg: any = { id: { fromMe: false, remote: '919999000001@c.us', id: 'ABC123' } };

    expect(ensureSerializedId(msg)).toBe('false_919999000001@c.us_ABC123');
    expect(msg.id._serialized).toBe('false_919999000001@c.us_ABC123');
});

// The day WhatsApp hands the property back, this must not overwrite it with a
// reconstruction.
test('ensureSerializedId leaves an existing id untouched', () => {
    const msg: any = { id: { fromMe: false, remote: '919999000001@c.us', id: 'ABC', _serialized: 'REAL' } };

    expect(ensureSerializedId(msg)).toBe('REAL');
    expect(msg.id._serialized).toBe('REAL');
});

// Capture must survive a malformed message — never throw, never invent.
test('ensureSerializedId reports null for an unrepairable message', () => {
    expect(ensureSerializedId(null)).toBeNull();
    expect(ensureSerializedId(undefined)).toBeNull();
    expect(ensureSerializedId({})).toBeNull();

    const msg: any = { id: { fromMe: false } };
    expect(ensureSerializedId(msg)).toBeNull();
    expect(msg.id._serialized).toBeUndefined();
});

// ── the page-side patch ──
//
// Exercised the way the page runs it: eval the source against a fake window
// carrying a stand-in WWebJS. This is the primary fix (it runs where the
// accessor still works), so its branches are worth covering directly.
function runPatch(win: any): string {
    const globalAny = globalThis as any;
    const previous = globalAny.window;
    globalAny.window = win;
    try {
        return (0, eval)(MESSAGE_MODEL_ID_PATCH);
    } finally {
        if (previous === undefined) delete globalAny.window;
        else globalAny.window = previous;
    }
}

// A live MsgKey still answers `_serialized` in-page — take it straight from
// there rather than reconstructing.
test('the patch fills _serialized from the live key', () => {
    const win: any = { WWebJS: { getMessageModel: (m: any) => ({ id: { ...m.id, _serialized: undefined } }) } };

    expect(runPatch(win)).toBe('patched');

    const model = win.WWebJS.getMessageModel({
        id: { fromMe: false, remote: '919999000001@c.us', id: 'ABC', _serialized: 'false_919999000001@c.us_ABC' }
    });
    expect(model.id._serialized).toBe('false_919999000001@c.us_ABC');
});

// toString() on a MsgKey yields the serialized id; on a plain object it yields
// "[object Object]", which would pass a truthiness check and poison every id
// written from it — so that shape must fall through to the manual rebuild.
test('the patch ignores a "[object Object]" toString and rebuilds from parts', () => {
    const win: any = { WWebJS: { getMessageModel: (m: any) => ({ id: { ...m.id } }) } };
    runPatch(win);

    const model = win.WWebJS.getMessageModel({
        id: { fromMe: true, remote: { _serialized: '919999000001@c.us' }, id: 'XYZ' }
    });
    expect(model.id._serialized).toBe('true_919999000001@c.us_XYZ');
});

test('the patch uses a MsgKey toString when there is no accessor', () => {
    const win: any = { WWebJS: { getMessageModel: (m: any) => ({ id: { fromMe: m.id.fromMe } }) } };
    runPatch(win);

    const key = { fromMe: false, toString: () => 'false_919999000001@c.us_TSTR' };
    expect(win.WWebJS.getMessageModel({ id: key }).id._serialized).toBe('false_919999000001@c.us_TSTR');
});

// A model without its id still carries the message; the repair must never be
// what breaks capture.
test('the patch leaves an unrepairable model alone and never throws', () => {
    const win: any = { WWebJS: { getMessageModel: () => ({ id: { fromMe: false } }) } };
    runPatch(win);

    expect(win.WWebJS.getMessageModel({ id: { fromMe: false } }).id._serialized).toBeUndefined();
    expect(win.WWebJS.getMessageModel({}).id._serialized).toBeUndefined();
    expect(win.WWebJS.getMessageModel({ id: null }).id._serialized).toBeUndefined();
});

test('the patch preserves an already-serialized model id', () => {
    const win: any = { WWebJS: { getMessageModel: () => ({ id: { _serialized: 'REAL' } }) } };
    runPatch(win);

    expect(win.WWebJS.getMessageModel({ id: {} }).id._serialized).toBe('REAL');
});

// Re-armed on every 'ready', so double application has to be free — wrapping
// the wrapper would re-run the repair for no gain.
test('the patch is idempotent and reports when it cannot install', () => {
    const win: any = { WWebJS: { getMessageModel: (m: any) => ({ id: { ...m.id } }) } };

    expect(runPatch(win)).toBe('patched');
    expect(runPatch(win)).toBe('already-patched');

    expect(runPatch({})).toBe('no-store');
    expect(runPatch({ WWebJS: {} })).toBe('no-store');
});
