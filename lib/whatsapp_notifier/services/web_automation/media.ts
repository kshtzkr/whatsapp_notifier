// Inbound media store (v0.7.0)
//
// Downloads customer media (images, voice notes, documents) to disk and serves
// it back to the host over GET /media/:userId/:messageId. Kept separate from
// index.ts (which calls Bun.serve() at import time) so every piece — id
// sanitization, the size/type policy, the TTL sweep, the download pipeline and
// the route responses — can be unit-tested without booting Chromium.
//
// Layout: <media root>/<safeUser>/<safeMessageId> holds the raw bytes and
// <safeMessageId>~meta.json the sidecar { mime, filename, size, capturedAt }.
// The '~' sits OUTSIDE the sanitize charset, so a hostile message id ending in
// ".json" can never name-collide with (or overwrite) another message's sidecar
// — data files and sidecars live in disjoint namespaces by construction. The
// media root is <SESSION_DIR>/media in production (survives restarts that wipe
// the in-memory inbound queues); tests point it at a tmp dir via
// configureMedia, mirroring configureInbound.

import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    rmSync,
    readdirSync,
    statSync
} from 'fs';
import { join, resolve, sep } from 'path';
import { createHash, timingSafeEqual } from 'crypto';

export interface MediaMeta {
    mime: string;
    filename: string | null;
    size: number;
    capturedAt: number; // epoch ms
}

export type MediaSkipReason = 'unsupported_type' | 'too_large' | 'disk_full';
export type MediaFailureReason = MediaSkipReason | 'expired' | 'download_failed' | 'invalid_id';

// The verdict captureInbound merges into the inbound payload. Structurally
// compatible with inbound.ts's optional media fields — every failure mode
// still surfaces the message itself, just without bytes.
export interface MediaResolution {
    mediaStatus: 'available' | 'unavailable';
    mediaError?: MediaFailureReason;
    mediaMime?: string;
    mediaFilename?: string;
    mediaSize?: number;
}

export type MediaPolicy = { download: true } | { download: false; reason: MediaSkipReason };

// Inline media (image / voice note) caps at WhatsApp's own 16MB ceiling;
// documents get a separate, env-tunable cap. Envs are read lazily (not frozen
// at import) so the limits can be retuned per deployment and per test.
export const INLINE_MEDIA_MAX_BYTES = 16 * 1024 * 1024;
export const MEDIA_DOWNLOAD_TIMEOUT_MS = 30000;

// Malformed env values ("50GB", "2 days") parse to NaN, and every NaN
// comparison is false — the TTL sweep and the disk cap would silently
// disable themselves. Fall back to the default instead.
function envLimit(name: string, fallback: number): number {
    const parsed = Number(process.env[name] || fallback);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function mediaTtlMs(): number {
    return envLimit('WHATSAPP_MEDIA_TTL_MS', 48 * 60 * 60 * 1000); // 48h
}

export function maxDocumentBytes(): number {
    return envLimit('WHATSAPP_MEDIA_MAX_BYTES', 25 * 1024 * 1024); // 25MB
}

export function maxDiskBytes(): number {
    return envLimit('WHATSAPP_MEDIA_MAX_DISK_BYTES', 5 * 1024 * 1024 * 1024); // 5GB
}

// ── Root + cap accounting ──

// index.ts wires this to <SESSION_BASE_DIR>/media; tests to a tmp dir.
let mediaRootResolver: () => string = () => './media';
// Total payload bytes on disk, kept incrementally by write/delete and
// recomputed by the sweep, so downloadPolicy's disk-full check is O(1).
let cachedDiskBytes: number | null = null;

export function configureMedia(rootResolver: () => string) {
    mediaRootResolver = rootResolver;
    cachedDiskBytes = null;
}

export function mediaDiskBytes(): number {
    if (cachedDiskBytes === null) cachedDiskBytes = computeDiskBytes();
    return cachedDiskBytes;
}

function computeDiskBytes(): number {
    let total = 0;
    try {
        const root = mediaRootResolver();
        for (const user of readdirSync(root, { withFileTypes: true })) {
            if (!user.isDirectory()) continue;
            const dir = join(root, user.name);
            for (const file of readdirSync(dir)) {
                if (isSidecarName(file)) continue; // sidecars are negligible
                try { total += statSync(join(dir, file)).size; } catch (_) { /* raced a delete */ }
            }
        }
    } catch (_) { /* media root not created yet → nothing stored */ }
    return total;
}

// ── Id sanitization + path layout ──

// Both route params become path segments, so they must be reduced to a safe
// charset. WhatsApp message ids ("true_9199...@c.us_ABC") and our numeric user
// ids fit [A-Za-z0-9@._-] untouched; anything else is hostile or garbage.
export function sanitizeId(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.replace(/[^A-Za-z0-9@._-]/g, '');
    if (!cleaned || cleaned.length > 200) return null;
    if (/^\.+$/.test(cleaned)) return null; // '.', '..', … are path-segment hazards
    return cleaned;
}

// Sidecar names end with a suffix whose '~' is outside the sanitize charset:
// no sanitized message id can ever produce (or overwrite) a sidecar name, so
// the accounting/sweep/orphan logic can tell the two apart by name alone.
const SIDECAR_SUFFIX = '~meta.json';

function isSidecarName(file: string): boolean {
    return file.endsWith(SIDECAR_SUFFIX);
}

export function mediaPaths(
    userId: string,
    messageId: string
): { dir: string; dataPath: string; metaPath: string } | null {
    const safeUser = sanitizeId(userId);
    const safeMessage = sanitizeId(messageId);
    if (!safeUser || !safeMessage) return null;

    const root = resolve(mediaRootResolver());
    const dir = resolve(root, safeUser);
    const dataPath = resolve(dir, safeMessage);
    // Belt and braces: even a sanitizer bug must never escape the media root.
    if (!dir.startsWith(root + sep) || !dataPath.startsWith(dir + sep)) return null;

    return { dir, dataPath, metaPath: `${dataPath}${SIDECAR_SUFFIX}` };
}

// ── Store primitives ──

export function writeMedia(
    userId: string,
    messageId: string,
    data: Uint8Array,
    meta: { mime: string; filename?: string | null }
): boolean {
    const paths = mediaPaths(userId, messageId);
    if (!paths) return false;
    try {
        mkdirSync(paths.dir, { recursive: true });
        writeFileSync(paths.dataPath, data);
        const sidecar: MediaMeta = {
            mime: meta.mime,
            filename: meta.filename ?? null,
            size: data.byteLength,
            capturedAt: Date.now()
        };
        writeFileSync(paths.metaPath, JSON.stringify(sidecar));
        if (cachedDiskBytes !== null) cachedDiskBytes += data.byteLength;
        return true;
    } catch (e) {
        console.error(`Failed to persist media ${messageId} for ${userId}`, e);
        return false;
    }
}

// Returns the sidecar when BOTH the bytes and the sidecar are present —
// captureInbound uses this to skip re-downloading on a reconnect backfill.
export function mediaExists(userId: string, messageId: string): MediaMeta | null {
    const paths = mediaPaths(userId, messageId);
    if (!paths) return null;
    try {
        if (!existsSync(paths.dataPath) || !existsSync(paths.metaPath)) return null;
        const raw = JSON.parse(readFileSync(paths.metaPath, 'utf8'));
        return {
            mime: typeof raw?.mime === 'string' ? raw.mime : 'application/octet-stream',
            filename: typeof raw?.filename === 'string' ? raw.filename : null,
            size: Number(raw?.size) || 0,
            capturedAt: Number(raw?.capturedAt) || 0
        };
    } catch (_) {
        return null; // corrupt sidecar → treat as absent (a re-download heals it)
    }
}

export function readMedia(userId: string, messageId: string): { data: Buffer; meta: MediaMeta } | null {
    const meta = mediaExists(userId, messageId);
    if (!meta) return null;
    try {
        return { data: readFileSync(mediaPaths(userId, messageId)!.dataPath), meta };
    } catch (_) {
        return null; // raced a sweep/delete between the exists check and the read
    }
}

// Logout privacy contract: stored media belongs to the OLD pairing. POST
// /logout wipes the session dir and the inbound queue, but without this the
// customer photos/documents stayed on disk — fetchable via GET /media — for
// up to the 48h TTL after the operator severed the pairing. Same sanitize +
// containment rules as mediaPaths; recomputing the cached disk total keeps
// downloadPolicy's cap check honest after a bulk removal.
export function clearUserMedia(userId: string): boolean {
    const safeUser = sanitizeId(userId);
    if (!safeUser) return false;
    const root = resolve(mediaRootResolver());
    const dir = resolve(root, safeUser);
    if (!dir.startsWith(root + sep)) return false;
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch (e) {
        console.error(`Failed to clear media dir for ${userId}`, e);
        return false;
    }
    cachedDiskBytes = computeDiskBytes();
    return true;
}

// Idempotent: deleting media that was never stored (or already swept) is fine.
export function deleteMedia(userId: string, messageId: string): boolean {
    const paths = mediaPaths(userId, messageId);
    if (!paths) return false;
    const meta = mediaExists(userId, messageId);
    try {
        rmSync(paths.dataPath, { force: true });
        rmSync(paths.metaPath, { force: true });
        if (meta && cachedDiskBytes !== null) {
            cachedDiskBytes = Math.max(0, cachedDiskBytes - meta.size);
        }
        return true;
    } catch (e) {
        console.error(`Failed to delete media ${messageId} for ${userId}`, e);
        return false;
    }
}

// ── Download policy ──

// Stickers and videos are deliberately not downloaded (no CMS rendering need,
// videos routinely blow the cap); view-once media must not be persisted at
// all — the sender chose ephemerality.
const DOWNLOADABLE_TYPES = new Set(['image', 'audio', 'ptt', 'document']);

export function downloadPolicy(type: string, size: number, viewOnce = false): MediaPolicy {
    if (viewOnce || !DOWNLOADABLE_TYPES.has(type)) return { download: false, reason: 'unsupported_type' };
    const cap = type === 'document' ? maxDocumentBytes() : INLINE_MEDIA_MAX_BYTES;
    if (size > cap) return { download: false, reason: 'too_large' };
    if (mediaDiskBytes() + size > maxDiskBytes()) return { download: false, reason: 'disk_full' };
    return { download: true };
}

// ── TTL sweep ──

// Remove media older than the TTL (the host attaches what it wants well within
// 48h; everything else is abandoned) plus orphaned sidecars, then refresh the
// disk-cap accounting. index.ts runs this on the existing reaper interval.
export function sweepExpired(nowMs = Date.now()): number {
    const ttl = mediaTtlMs();
    let removed = 0;
    try {
        const root = mediaRootResolver();
        for (const user of readdirSync(root, { withFileTypes: true })) {
            if (!user.isDirectory()) continue;
            const dir = join(root, user.name);
            for (const file of readdirSync(dir)) {
                if (isSidecarName(file)) continue;
                const dataPath = join(dir, file);
                if (nowMs - capturedAtFor(dataPath, `${dataPath}${SIDECAR_SUFFIX}`) > ttl) {
                    rmSync(dataPath, { force: true });
                    rmSync(`${dataPath}${SIDECAR_SUFFIX}`, { force: true });
                    removed += 1;
                }
            }
            // Sidecars whose payload is already gone are garbage regardless of age.
            for (const file of readdirSync(dir)) {
                if (isSidecarName(file) && !existsSync(join(dir, file.slice(0, -SIDECAR_SUFFIX.length)))) {
                    rmSync(join(dir, file), { force: true });
                }
            }
        }
    } catch (_) { /* media root not created yet → nothing to sweep */ }
    cachedDiskBytes = computeDiskBytes();
    return removed;
}

function capturedAtFor(dataPath: string, metaPath: string): number {
    try {
        const raw = JSON.parse(readFileSync(metaPath, 'utf8'));
        const capturedAt = Number(raw?.capturedAt);
        if (Number.isFinite(capturedAt) && capturedAt > 0) return capturedAt;
    } catch (_) { /* missing/corrupt sidecar → fall back to the file clock */ }
    try {
        return statSync(dataPath).mtimeMs;
    } catch (_) {
        return 0; // unstattable → looks ancient → swept
    }
}

// ── Download pipeline ──

// Policy pre-check on the declared size → bounded downloadMedia() → policy
// re-check on the actual bytes → persist. Every failure mode returns a typed
// 'unavailable' verdict instead of throwing: the message itself must always
// reach the host, with or without its bytes.
export async function resolveMediaForMessage(
    userId: string,
    msg: any,
    deps: { timeoutMs?: number } = {}
): Promise<MediaResolution> {
    // Must mirror normalizeInbound's messageId fallback (inbound.ts) so the
    // stored file is addressable by the id the host received.
    const messageId = (msg?.id && msg.id._serialized) || `${msg?.from || ''}-${msg?.timestamp}`;
    if (!mediaPaths(userId, messageId)) {
        return { mediaStatus: 'unavailable', mediaError: 'invalid_id' };
    }

    // Reconnect backfill replays recent messages — serve the copy already on
    // disk instead of re-downloading (and re-counting against the disk cap).
    const existing = mediaExists(userId, messageId);
    if (existing) return availableResolution(existing.mime, existing.filename, existing.size);

    const type = msg?.type || 'chat';
    const viewOnce = !!(msg?._data?.isViewOnce);
    const declaredSize = Number(msg?._data?.size) || 0; // 0 = unknown → re-checked post-download
    const pre = downloadPolicy(type, declaredSize, viewOnce);
    if (!pre.download) return { mediaStatus: 'unavailable', mediaError: pre.reason };

    let media: any;
    try {
        media = await withTimeout(
            (async () => msg.downloadMedia())(),
            deps.timeoutMs ?? MEDIA_DOWNLOAD_TIMEOUT_MS
        );
    } catch (e) {
        console.error(`Media download failed for ${userId}/${messageId}`, e);
        return { mediaStatus: 'unavailable', mediaError: 'download_failed' };
    }
    // whatsapp-web.js resolves undefined when the media is no longer on
    // WhatsApp's servers (old message, sender deleted it, …).
    if (!media || !media.data) return { mediaStatus: 'unavailable', mediaError: 'expired' };

    const data = Buffer.from(media.data, 'base64');
    // The declared size is advisory — re-apply the caps to the real bytes.
    const post = downloadPolicy(type, data.byteLength, viewOnce);
    if (!post.download) return { mediaStatus: 'unavailable', mediaError: post.reason };

    const mime = media.mimetype || msg?._data?.mimetype || 'application/octet-stream';
    const filename = media.filename || msg?._data?.filename || null;
    if (!writeMedia(userId, messageId, data, { mime, filename })) {
        return { mediaStatus: 'unavailable', mediaError: 'download_failed' };
    }
    return availableResolution(mime, filename, data.byteLength);
}

function availableResolution(mime: string, filename: string | null, size: number): MediaResolution {
    return {
        mediaStatus: 'available',
        mediaMime: mime,
        ...(filename ? { mediaFilename: filename } : {}),
        mediaSize: size
    };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(
            () => rejectPromise(new Error(`media download timed out after ${ms}ms`)),
            ms
        );
        promise.then(
            (value) => { clearTimeout(timer); resolvePromise(value); },
            (err) => { clearTimeout(timer); rejectPromise(err); }
        );
    });
}

// ── Route responses ──
//
// Full Response builders for GET/DELETE /media/:userId/:messageId so index.ts
// stays glue-only and the route contract is unit-testable. Neither handler may
// ever create a WhatsApp client (same fast-reject rule as GET /inbound): they
// touch only the on-disk store.

// X-WA-Token check shared by both /media routes — ENFORCED ONLY when the
// service has WHATSAPP_WEBHOOK_TOKEN set (mirrors the host's webhook receiver,
// which reuses the same shared secret in the other direction). Hashing both
// sides first gives constant-length inputs for the timing-safe comparison.
export function verifyMediaToken(provided: string | undefined, expected: string | undefined): boolean {
    if (!expected) return true;
    const a = createHash('sha256').update(provided ?? '').digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

// Keep stored filenames from smuggling header syntax (quotes, CR/LF) into
// Content-Disposition.
function headerSafeFilename(name: string): string {
    return name.replace(/[^A-Za-z0-9@. _-]/g, '_');
}

export function mediaGetResponse(
    userId: string,
    messageId: string,
    token: string | undefined,
    expectedToken: string | undefined
): Response {
    if (!verifyMediaToken(token, expectedToken)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const found = readMedia(userId, messageId); // sanitizes both ids itself
    if (!found) {
        // Unknown, swept, deleted AND invalid ids all answer the same 404 —
        // the route must not reveal which.
        return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return new Response(found.data, {
        status: 200,
        headers: {
            'Content-Type': found.meta.mime || 'application/octet-stream',
            'Content-Length': String(found.data.byteLength),
            'Content-Disposition': found.meta.filename
                ? `attachment; filename="${headerSafeFilename(found.meta.filename)}"`
                : 'attachment'
        }
    });
}

// Idempotent by contract: the host calls this after attaching the bytes, and a
// retry (or a TTL sweep racing it) must not turn into an error.
export function mediaDeleteResponse(
    userId: string,
    messageId: string,
    token: string | undefined,
    expectedToken: string | undefined
): Response {
    if (!verifyMediaToken(token, expectedToken)) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    deleteMedia(userId, messageId);
    return Response.json({ success: true });
}

// Test helper: wipe in-memory state between examples (mirrors resetInboundState).
export function resetMediaState() {
    cachedDiskBytes = null;
}
