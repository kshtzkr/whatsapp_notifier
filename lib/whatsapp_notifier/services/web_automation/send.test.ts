import { test, expect } from 'bun:test';
import { sentMessageId } from './send';

// The id the host stores against its outbound record — it MUST be the real
// serialized WhatsApp id so the fromMe echo of this send dedupes on it.
test('sentMessageId returns the serialized id of the sent message', () => {
    const sent = { id: { _serialized: 'true_919999000001@c.us_ABC' } };
    expect(sentMessageId(sent)).toBe('true_919999000001@c.us_ABC');
});

// Null fallback, never a fabricated id: a made-up id matches no echo but
// would still occupy the host's unique message-id slot, blocking the echo
// from being adopted onto the right record.
test('sentMessageId falls back to null when no id is available', () => {
    expect(sentMessageId(undefined)).toBeNull();          // library resolved nothing
    expect(sentMessageId(null)).toBeNull();
    expect(sentMessageId({})).toBeNull();                 // Message without an id
    expect(sentMessageId({ id: {} })).toBeNull();         // id without a serialization
    expect(sentMessageId({ id: { _serialized: '' } })).toBeNull(); // empty id is no id
});
