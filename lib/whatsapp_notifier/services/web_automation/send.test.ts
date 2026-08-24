import { test, expect } from 'bun:test';
import { sentMessageId, sendValidationError, fetchMedia, captionOptions, isLidResolutionError } from './send';

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

// ── /send body validation ──
//
// Hosts attach files one-by-one with the caption only on the FIRST file, so
// a file-only body (message "" + mediaUrl) is the NORMAL shape for files
// 2..n of a batch — it must pass, not 422.
test('file-only send (to + mediaUrl, no message) passes validation', () => {
    expect(sendValidationError({ to: '919999000001', message: '', mediaUrl: 'https://host/blob/1' })).toBeNull();
    expect(sendValidationError({ to: '919999000001', mediaUrl: 'https://host/blob/1' })).toBeNull();
});

test('message-only send still passes validation', () => {
    expect(sendValidationError({ to: '919999000001', message: 'hello' })).toBeNull();
});

test('message + media together pass validation', () => {
    expect(sendValidationError({ to: '919999000001', message: 'caption', mediaUrl: 'https://host/blob/1' })).toBeNull();
});

test('a body with nothing to deliver is rejected with 422 copy', () => {
    const error = '`to` and one of `message`/`mediaUrl` are required';
    expect(sendValidationError({ to: '919999000001' })).toBe(error);
    expect(sendValidationError({ to: '919999000001', message: '', mediaUrl: '' })).toBe(error);
});

test('`to` is always required, media or not', () => {
    const error = '`to` and one of `message`/`mediaUrl` are required';
    expect(sendValidationError({ message: 'hello' })).toBe(error);
    expect(sendValidationError({ to: '', message: 'hello', mediaUrl: 'https://host/blob/1' })).toBe(error);
});

// ── media fetch options ──
//
// ActiveStorage blob/proxy URLs carry no file extension, so wwebjs's
// URL-based MIME sniff throws ("Unable to determine MIME type using URL").
// The send path MUST pass unsafeMime so the response Content-Type is used.
test('fetchMedia downloads with unsafeMime so extension-less URLs work', async () => {
    const calls: Array<[string, object | undefined]> = [];
    const fakeMessageMedia = {
        fromUrl: async (url: string, options?: object) => { calls.push([url, options]); return 'the-media'; }
    };

    const media = await fetchMedia(fakeMessageMedia, 'https://host/rails/active_storage/blobs/proxy/abc123');

    expect(media).toBe('the-media');
    expect(calls).toEqual([['https://host/rails/active_storage/blobs/proxy/abc123', { unsafeMime: true }]]);
});

// ── caption shape ──
test('captionOptions carries the caption when there is one', () => {
    expect(captionOptions('itinerary attached')).toEqual({ caption: 'itinerary attached' });
});

test('captionOptions omits the caption entirely for caption-less files', () => {
    expect(captionOptions('')).toEqual({});
    expect(captionOptions(undefined)).toEqual({});
    expect(captionOptions(null)).toEqual({});
});

// ── LID resolution failures ──
//
// These are WhatsApp's OWN assertion texts, thrown inside its bundle when the
// chat table has no LID row for the recipient. There is no error code to key
// on — the text is the whole signal — and the stack tail WhatsApp appends
// (its minified bundle URL) must not stop the match.
test('isLidResolutionError recognises both WhatsApp LID assertions', () => {
    expect(isLidResolutionError(new Error('Lid is missing in chat table\ns (https://static.whatsapp.net/rsrc.php/v4/y3/r/QOqeh94VsFD.js:84:180)')))
        .toBe(true);
    expect(isLidResolutionError(new Error('No LID for user\ns (https://static.whatsapp.net/rsrc.php/v4/y3/r/QOqeh94VsFD.js:84:180)')))
        .toBe(true);
    expect(isLidResolutionError('No LID for user')).toBe(true); // thrown as a bare string
});

test('isLidResolutionError leaves unrelated send failures alone', () => {
    expect(isLidResolutionError(new Error('Evaluation failed: TypeError'))).toBe(false);
    expect(isLidResolutionError(new Error('User not authenticated'))).toBe(false);
    expect(isLidResolutionError(undefined)).toBe(false);
});
