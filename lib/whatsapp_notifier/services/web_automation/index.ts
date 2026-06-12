import { Client, LocalAuth } from 'whatsapp-web.js';
import { Hono } from 'hono';
import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { toDataURL } from 'qrcode';
import { newCounters, renderMetrics, isWsEndpointTimeout, healthSnapshot } from './metrics';
import { InitGate } from './init_gate';
import {
    hasPairedSession,
    InitRetryLimiter,
    reapLimitMs,
    touchClient,
    shouldWipeSessionOnReap
} from './sessions';
import {
    InboundMsg,
    configureInbound,
    rememberTarget,
    backfillTargets,
    drainInbound,
    clearInbound,
    processInbound
} from './inbound';
import {
    configureMedia,
    resolveMediaForMessage,
    sweepExpired,
    clearUserMedia,
    mediaGetResponse,
    mediaDeleteResponse
} from './media';

const app = new Hono();
const port = Number(process.env.PORT || 3001);
const SESSION_BASE_DIR = process.env.WHATSAPP_SESSION_DIR || '/whatsapp_data';
const BROWSER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

// Recycle a client that boots Chromium but never reaches QR/READY (e.g. after a
// WhatsApp Web update breaks the injected store), instead of wedging in
// INITIALIZING forever with no QR.
const INIT_TIMEOUT_MS = Number(process.env.WHATSAPP_INIT_TIMEOUT_MS || 90000);
// Optionally pin the WhatsApp Web build so a live web.whatsapp.com change can't
// silently break the client. Set WWEBJS_WEB_VERSION to a known-good version
// (e.g. "2.3000.1023204887"); leave unset to use the library default.
const WEB_VERSION = process.env.WWEBJS_WEB_VERSION || null;
const WEB_VERSION_CACHE_URL = process.env.WWEBJS_WEB_VERSION_CACHE_URL ||
    'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html';

// Multi-user client management
interface ClientData {
    client: Client;
    state: 'INITIALIZING' | 'QR_REQUIRED' | 'AUTHENTICATED' | 'DISCONNECTED';
    qr: string | null;
    lastUsed: number;
    isDestroying?: boolean;
    ready?: boolean;
    // True once the 'authenticated' event has ever fired for this client.
    // Distinguishes a real (possibly wedged) session from an abandoned
    // pairing visit whose LocalAuth dir holds no credentials at all.
    everAuthenticated?: boolean;
    initTimer?: ReturnType<typeof setTimeout>;
    releaseInitSlot?: () => void;
}

const clients = new Map<string, ClientData>();
const initializingClients = new Set<string>();

// Bound the post-failure initialize() retries (the old "retry once" comment
// lied: it rescheduled forever). Budget resets on 'ready' and on destroy.
const MAX_INIT_RETRIES = 2;
const initRetries = new InitRetryLimiter(MAX_INIT_RETRIES);

// ── Inbound capture — core logic lives in ./inbound.ts ──
// Resolves customer replies (incl. newer @lid privacy-ids) and buffers them for
// GET /inbound/:userId, which the Rails poller drains + matches to a campaign.
const WEBHOOK_URL = process.env.WHATSAPP_WEBHOOK_URL;
const WEBHOOK_TOKEN = process.env.WHATSAPP_WEBHOOK_TOKEN;

// Tell the inbound core how to resolve each user's on-disk session dir, and
// the media store where downloaded inbound media lives (survives restarts).
configureInbound(sessionDirForUser);
configureMedia(() => join(SESSION_BASE_DIR, 'media'));

async function pushWebhook(userId: string, msg: InboundMsg) {
    if (!WEBHOOK_URL) return;
    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(WEBHOOK_TOKEN ? { 'X-WA-Token': WEBHOOK_TOKEN } : {})
            },
            body: JSON.stringify({ userId, message: msg })
        });
    } catch (e) {
        console.error(`Webhook push failed for ${userId}`, e);
    }
}

// Wrapper around the testable pipeline in inbound.ts (sanity filter → sender
// resolution with early @lid drop → media download → normalize → enqueue →
// webhook). The catch keeps a single bad message from killing the listener.
async function captureInbound(userId: string, msg: any) {
    try {
        await processInbound(userId, msg, {
            resolveMedia: resolveMediaForMessage,
            push: pushWebhook
        });
    } catch (e) {
        console.error(`captureInbound error for ${userId}`, e);
    }
}

async function backfillInbound(userId: string, client: Client) {
    // On reconnect, replay recent messages ONLY from chats we actually messaged
    // (the per-send allowlist) so a disconnect window doesn't drop a reply —
    // without scraping every personal conversation on the linked number. Live
    // replies are covered by the message_create handler; this is just recovery.
    await backfillTargets(userId, client, captureInbound);
}

// Prometheus counters + process start for the /metrics endpoint.
const counters = newCounters();
const SERVICE_START = Date.now();

// Cap concurrent Chromium launches (see init_gate.ts) so a herd of cold starts
// can't exhaust RAM/CPU. Env-overridable.
const initGate = new InitGate(Number(process.env.WHATSAPP_MAX_CONCURRENT_INITS || 3));

// Puppeteer launch hardening: the default 30s WS-endpoint wait + protocol
// timeout are too tight when several Chromiums cold-launch at once under memory
// pressure, producing "WS endpoint URL" / "Runtime.evaluate timed out" crash
// loops. Raise both (env-overridable).
const BROWSER_LAUNCH_TIMEOUT_MS = Number(process.env.WHATSAPP_BROWSER_TIMEOUT_MS || 60000);
const PROTOCOL_TIMEOUT_MS = Number(process.env.WHATSAPP_PROTOCOL_TIMEOUT_MS || 120000);

function clearInitTimer(clientData: ClientData) {
    if (clientData.initTimer) {
        clearTimeout(clientData.initTimer);
        clientData.initTimer = undefined;
    }
    // Free the launch slot (idempotent) once the client makes progress or ends.
    if (clientData.releaseInitSlot) {
        clientData.releaseInitSlot();
    }
}

function sessionDirForUser(userId: string) {
    return join(SESSION_BASE_DIR, `session-user-${userId}`);
}

function clearChromiumSingletonLocks(userId: string) {
    const lockFiles = ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'lockfile'];

    // Clean locks from session dir and all subdirectories recursively
    function cleanDir(dir: string) {
        if (!existsSync(dir)) return;

        lockFiles.forEach((fileName) => {
            const filePath = join(dir, fileName);
            try {
                rmSync(filePath, { force: true });
            } catch (e) {
                // Ignore
            }
        });

        try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) {
                    cleanDir(join(dir, entry.name));
                }
            }
        } catch (_) { /* ignore permission errors on nested dirs */ }
    }

    cleanDir(sessionDirForUser(userId));
    // Also clean the base session dir itself
    cleanDir(SESSION_BASE_DIR);
}

function isTransientSendError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("getChat") || message.includes("Cannot read properties of undefined");
}

async function waitForClientReady(clientData: ClientData, timeoutMs = 30000): Promise<void> {
    if (clientData.ready) return;

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (clientData.ready) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('Client not ready: WhatsApp Web store did not initialize in time');
}

async function sendMessageWithRetry(client: Client, clientData: ClientData, chatId: string, message: string, mediaUrl?: string | null) {
    const maxAttempts = 5;

    // Wait for the internal WWeb store to be fully loaded before first attempt
    await waitForClientReady(clientData);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            if (mediaUrl) {
                const { MessageMedia } = require('whatsapp-web.js');
                const media = await MessageMedia.fromUrl(mediaUrl);
                await client.sendMessage(chatId, media, { caption: message });
            } else {
                await client.sendMessage(chatId, message);
            }

            return;
        } catch (error) {
            console.error(`Send attempt ${attempt}/${maxAttempts} failed for chat ${chatId}:`, error);

            if (!isTransientSendError(error) || attempt === maxAttempts) {
                throw error;
            }

            // Wait longer between retries to give the store time to hydrate
            await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
        }
    }
}

// Helper to get or create a client for a user
async function getOrCreateClient(userId: string): Promise<ClientData> {
    if (clients.has(userId)) {
        const data = clients.get(userId)!;
        if (data.isDestroying) return data;
        // Only READY clients earn a lastUsed refresh (see touchClient): an
        // unready client must keep looking idle so the reaper can collect it
        // even while /send or /status traffic keeps hitting it.
        touchClient(data);
        return data;
    }

    // Prevent race conditions from concurrent status polls
    if (initializingClients.has(userId)) {
        // Return a temporary placeholder while initialization is in progress
        return { client: null as any, state: 'INITIALIZING', qr: null, lastUsed: Date.now(), ready: false };
    }
    initializingClients.add(userId);

    console.log(`Initializing new WhatsApp client for User: ${userId}`);
    clearChromiumSingletonLocks(userId);

    const client = new Client({
        authStrategy: new LocalAuth({
            clientId: `user-${userId}`,
            dataPath: SESSION_BASE_DIR
        }),
        puppeteer: {
            headless: true,
            timeout: BROWSER_LAUNCH_TIMEOUT_MS,
            protocolTimeout: PROTOCOL_TIMEOUT_MS,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            ...(BROWSER_EXECUTABLE_PATH ? { executablePath: BROWSER_EXECUTABLE_PATH } : {})
        },
        ...(WEB_VERSION ? {
            webVersion: WEB_VERSION,
            webVersionCache: { type: 'remote' as const, remotePath: WEB_VERSION_CACHE_URL }
        } : {})
    });

    const clientData: ClientData = {
        client,
        state: 'INITIALIZING',
        qr: null,
        lastUsed: Date.now(),
        ready: false
    };

    clients.set(userId, clientData);

    client.on('qr', async (qr) => {
        clientData.state = 'QR_REQUIRED';
        clearInitTimer(clientData); // progress made — QR is showable
        try {
            clientData.qr = await toDataURL(qr);
            console.log(`QR RECEIVED and converted for User ${userId}`);
        } catch (err) {
            console.error('Failed to convert QR to DataURL', err);
        }
    });

    client.on('ready', () => {
        clientData.state = 'AUTHENTICATED';
        clientData.qr = null;
        clientData.ready = true;
        clearInitTimer(clientData);
        initRetries.reset(userId);
        console.log(`Client is READY for User ${userId}`);
        // Replay anything that arrived while we were disconnected.
        backfillInbound(userId, client).catch((e) => console.error(`Backfill failed for ${userId}`, e));
    });

    // Capture inbound replies. Only 'message_create' — it fires reliably for
    // every message across linked/multi-device sessions (plain 'message'
    // silently never fires on some). shouldCapture drops our own sends (fromMe)
    // + groups/status; the queue dedupes on message_id on the Rails side.
    client.on('message_create', (msg) => captureInbound(userId, msg));

    client.on('authenticated', () => {
        clientData.state = 'AUTHENTICATED';
        clientData.ready = false;
        clientData.everAuthenticated = true;
        clearInitTimer(clientData);
        console.log(`AUTHENTICATED for User ${userId}`);
    });

    client.on('auth_failure', (msg) => {
        clientData.state = 'DISCONNECTED';
        clientData.ready = false;
        clearInitTimer(clientData);
        counters.auth_failures_total += 1;
        console.error(`AUTHENTICATION FAILURE for User ${userId}`, msg);
    });

    client.on('disconnected', (reason) => {
        clientData.state = 'DISCONNECTED';
        clientData.ready = false;
        counters.disconnects_total += 1;
        console.log(`User ${userId} was logged out`, reason);
        destroyClient(userId).catch(console.error);
    });

    // Gate the Chromium launch: cap concurrent initialize() calls so a herd of
    // cold starts (e.g. every operator reconnecting after a reboot) can't
    // exhaust RAM/CPU and crash-loop on "WS endpoint URL" timeouts. Queued
    // clients launch as slots free; the slot is released (idempotently, via
    // clearInitTimer) the moment the client makes progress or fails.
    initGate.acquire().then((release) => {
        clientData.releaseInitSlot = release;

        // Recycled/destroyed while waiting in the queue — free the slot and bail
        // (never initialize a client that's no longer the live one for this user).
        if (clientData.isDestroying || clients.get(userId) !== clientData) {
            release();
            return;
        }

        // Watchdog: recycle a client that boots Chromium but never reaches
        // QR/READY. Armed here so it times the actual launch, not the queue wait.
        clientData.initTimer = setTimeout(() => {
            if (clientData.state === 'INITIALIZING' && !clientData.qr && !clientData.ready) {
                counters.init_timeouts_total += 1;
                console.error(`User ${userId} stuck INITIALIZING > ${INIT_TIMEOUT_MS}ms — recycling`);
                destroyClient(userId).catch(console.error);
            }
        }, INIT_TIMEOUT_MS);

        client.initialize().catch(async (err) => {
            const message = err?.message || String(err);
            counters.init_failures_total += 1;
            if (isWsEndpointTimeout(message)) counters.ws_endpoint_timeouts_total += 1;
            console.error(`Initialization failed for user ${userId}:`, message);
            clearInitTimer(clientData); // also releases the init slot
            // Clean up the failed client
            try { client.removeAllListeners(); } catch (_) {}
            try { await client.destroy(); } catch (_) {}
            clients.delete(userId);
            initializingClients.delete(userId);

            // Auto-retry after a cooldown — bounded per user, because an
            // unbounded loop relaunches Chromium forever on a broken session.
            if (!initRetries.shouldRetry(userId)) {
                console.error(`Giving up on user ${userId} after ${MAX_INIT_RETRIES} failed init retries`);
                return;
            }
            console.log(`Will retry initialization for user ${userId} in 10s (retry ${initRetries.attemptsFor(userId)}/${MAX_INIT_RETRIES})...`);
            setTimeout(() => {
                // A pending retry must not resurrect a user who logged out in
                // the meantime (POST /logout wipes the session dir): that
                // client would go straight to a QR zombie.
                if (!existsSync(sessionDirForUser(userId))) {
                    console.log(`Skipping init retry for user ${userId} — session dir is gone (logged out)`);
                    return;
                }
                getOrCreateClient(userId).catch(console.error);
            }, 10000);
        });
    });

    initializingClients.delete(userId);
    return clientData;
}

async function destroyClient(userId: string, clearSession: boolean = false) {
    const data = clients.get(userId);
    initRetries.reset(userId);
    if (data && !data.isDestroying) {
        data.isDestroying = true;
        clearInitTimer(data);
        console.log(`Destroying WhatsApp client for User: ${userId} (clearSession: ${clearSession})`);
        try {
            // Unregister listeners to prevent loops or double-destroys
            data.client.removeAllListeners();
            await data.client.destroy();
        } catch (e) {
            console.error(`Error destroying client for ${userId}`, e);
        }
        clients.delete(userId);
        // Session data is preserved on disk for auto-reconnect (unless clearing below).
    }
    // On explicit logout, wipe the persisted Chromium profile / WhatsApp session
    // from disk — even if there was no live client in memory.
    if (clearSession) {
        const dir = sessionDirForUser(userId);
        try {
            rmSync(dir, { recursive: true, force: true });
            console.log(`Cleared session dir for User: ${userId}`);
        } catch (e) {
            console.error(`Failed to clear session dir for ${userId}`, e);
        }
    }
}

// Cleanup sweep, every 5 minutes — a cheap O(clients) scan. The old hourly
// sweep made the 30-min unready limit really 30-90 min depending on where the
// idle window fell; 5-minute granularity keeps it at 30-35 min worst case.
// Ready clients are reaped after 72h idle; non-ready clients
// (e.g. a QR_REQUIRED zombie left by an abandoned pairing screen)
// after 30 min — they must not hold a full Chromium for 3 days, and only
// ready clients refresh lastUsed on access (see touchClient), so a zombie
// looks idle no matter how much /send traffic hits it. When the reaped
// client NEVER authenticated, its (credential-less) session dir is removed
// too — otherwise the leftover LocalAuth dir keeps hasPairedSession true and
// defeats the fast-reject gate forever. Ever-authenticated sessions stay on
// disk so a wedge-reaped user reconnects without a new QR.
const STAGNATION_LIMIT = 72 * 60 * 60 * 1000; // 72 hours
const UNREADY_REAP_MS = Number(process.env.WHATSAPP_UNREADY_REAP_MS || 1800000); // 30 min
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

setInterval(() => {
    const now = Date.now();

    for (const [userId, data] of clients.entries()) {
        const limit = reapLimitMs(data, STAGNATION_LIMIT, UNREADY_REAP_MS);
        if (now - data.lastUsed > limit) {
            const wipe = shouldWipeSessionOnReap(data);
            console.log(`Auto-cleaning ${data.ready ? 'stagnant' : 'unready'} session for User: ${userId}${wipe ? ' (never authenticated — removing session dir)' : ''}`);
            destroyClient(userId, wipe).catch(console.error);
        }
    }

    // Evict downloaded inbound media past its TTL (and refresh the disk-cap
    // accounting) on the same cadence — a sweep failure must not stop reaping.
    try {
        sweepExpired();
    } catch (e) {
        console.error('Media sweep failed', e);
    }
}, SWEEP_INTERVAL_MS);

// API Routes

// Prometheus scrape endpoint (Grafana Alloy reads this over localhost). Exposes
// per-user session state + crash counters so we can alert on the recurring
// failure modes (init crash-loop, AUTHENTICATED-but-not-ready wedge, etc.).
app.get('/metrics', (c) => {
    const uptimeSeconds = Math.floor((Date.now() - SERVICE_START) / 1000);
    return new Response(renderMetrics(clients, counters, uptimeSeconds), {
        headers: { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' },
    });
});

// Liveness probe. The old service had no health route, so platform probes
// (Azure) 404'd and falsely reported the service down. Must stay side-effect
// free: never call getOrCreateClient here.
app.get('/health', (c) => {
    const uptimeSeconds = Math.floor((Date.now() - SERVICE_START) / 1000);
    return c.json(healthSnapshot(clients, uptimeSeconds));
});

app.get('/status/:userId', async (c) => {
    const userId = c.req.param('userId');
    const data = await getOrCreateClient(userId);
    return c.json({
        state: data.state,
        authenticated: data.state === 'AUTHENTICATED' && !!data.ready,
        hasQR: !!data.qr
    });
});

app.get('/qr/:userId', async (c) => {
    const userId = c.req.param('userId');
    const data = await getOrCreateClient(userId);
    return c.json({ qr: data.qr });
});

// Explicit per-user logout: disconnect the client and wipe the saved WhatsApp
// session from disk so the next connect starts fresh with a new QR. Triggered by
// the user-settings "Log out WhatsApp" button — NOT by app sign-out.
app.post('/logout/:userId', async (c) => {
    const userId = c.req.param('userId');
    console.log(`Logout requested for User: ${userId}`);
    await destroyClient(userId, true);
    // Drop the not-yet-polled inbound queue + cached target allowlist. The
    // gated GET /inbound answers [] for unpaired users WITHOUT draining, so
    // anything captured between the last poll and this logout would sit in
    // memory and replay into the WRONG pairing if this userId pairs again.
    clearInbound(userId);
    // Logout privacy contract: downloaded media belongs to the old pairing.
    // Without this wipe, customer photos/documents stayed on disk (and
    // fetchable via GET /media) for up to the 48h TTL after the operator
    // severed the pairing.
    clearUserMedia(userId);
    initializingClients.delete(userId);
    return c.json({ success: true });
});

app.post('/send/:userId', async (c) => {
    const userId = c.req.param('userId');
    const { to, message, mediaUrl } = await c.req.json();
    if (!to || !message) {
        return c.json({ success: false, error: 'Both `to` and `message` are required' }, 422);
    }
    // Never spawn a client just to fail the auth check below: a send for a
    // never-paired user (e.g. a job defaulting to user "default") would
    // otherwise boot a full Chromium that parks in QR_REQUIRED forever.
    if (!hasPairedSession(userId, clients, sessionDirForUser)) {
        return c.json({ success: false, error: 'No saved WhatsApp session for this user — pair via QR first' }, 401);
    }
    const data = await getOrCreateClient(userId);

    if (data.state !== 'AUTHENTICATED' || !data.ready) {
        return c.json({ success: false, error: 'User not authenticated' }, 401);
    }

    try {
        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        await sendMessageWithRetry(data.client, data, chatId, message, mediaUrl);

        // Record the recipient so their replies survive a reconnect backfill.
        rememberTarget(userId, chatId);

        data.lastUsed = Date.now();
        return c.json({ success: true });
    } catch (error: any) {
        console.error(`Send error for user ${userId}:`, error);
        return c.json({ success: false, error: error.message }, 500);
    }
});

// GET /inbound/:userId — drain the user's pending inbound queue.
// Returns { messages: [...] } and clears the buffer (at-least-once; the Rails
// side dedupes on messageId and matches the resolved phone to a campaign).
app.get('/inbound/:userId', async (c) => {
    const userId = c.req.param('userId');
    // A poll for a never-paired user can't have queued messages — answer empty
    // without creating a client (same zombie-Chromium hazard as /send).
    if (!hasPairedSession(userId, clients, sessionDirForUser)) {
        return c.json({ messages: [] });
    }
    await getOrCreateClient(userId);
    return c.json({ messages: drainInbound(userId) });
});

// GET/DELETE /media/:userId/:messageId — serve / evict downloaded inbound
// media. Token-gated when WHATSAPP_WEBHOOK_TOKEN is set; ids are sanitized in
// the store; NEVER calls getOrCreateClient (same fast-reject rule as /inbound:
// fetching bytes for a never-paired user must not boot a Chromium).
app.get('/media/:userId/:messageId', (c) =>
    mediaGetResponse(c.req.param('userId'), c.req.param('messageId'), c.req.header('X-WA-Token'), WEBHOOK_TOKEN));

app.delete('/media/:userId/:messageId', (c) =>
    mediaDeleteResponse(c.req.param('userId'), c.req.param('messageId'), c.req.header('X-WA-Token'), WEBHOOK_TOKEN));


console.log(`Starting Multi-User WhatsApp service (Bun Native) on port ${port}...`);

// Prevent unhandled errors from crashing the entire Bun process
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection (caught globally, process stays alive):', reason);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception (caught globally, process stays alive):', err.message);
});

process.on('exit', (code) => {
    console.log(`BUN PROCESS EXITING WITH CODE: ${code}`);
});

process.on('SIGTERM', () => {
    console.log('BUN RECEIVED SIGTERM');
    process.exit(0);
});

// Correct way to keep Bun process alive with Hono
export default Bun.serve({
    port: port,
    fetch: app.fetch,
});
