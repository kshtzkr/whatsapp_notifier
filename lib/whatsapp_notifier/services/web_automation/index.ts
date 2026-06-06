import { Client, LocalAuth } from 'whatsapp-web.js';
import { Hono } from 'hono';
import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { toDataURL } from 'qrcode';
import { newCounters, renderMetrics, isWsEndpointTimeout } from './metrics';
import { InitGate } from './init_gate';

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
    initTimer?: ReturnType<typeof setTimeout>;
    releaseInitSlot?: () => void;
}

const clients = new Map<string, ClientData>();
const initializingClients = new Set<string>();

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
        data.lastUsed = Date.now();
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
        console.log(`Client is READY for User ${userId}`);
    });

    client.on('authenticated', () => {
        clientData.state = 'AUTHENTICATED';
        clientData.ready = false;
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

            // Auto-retry once after a cooldown
            console.log(`Will retry initialization for user ${userId} in 10s...`);
            setTimeout(() => {
                getOrCreateClient(userId).catch(console.error);
            }, 10000);
        });
    });

    initializingClients.delete(userId);
    return clientData;
}

async function destroyClient(userId: string, clearSession: boolean = false) {
    const data = clients.get(userId);
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

// 72-hour stagnation cleanup
setInterval(() => {
    const now = Date.now();
    const STAGNATION_LIMIT = 72 * 60 * 60 * 1000; // 72 hours

    for (const [userId, data] of clients.entries()) {
        if (now - data.lastUsed > STAGNATION_LIMIT) {
            console.log(`Auto-cleaning stagnant session for User: ${userId}`);
            destroyClient(userId).catch(console.error);
        }
    }
}, 60 * 60 * 1000); // Check every hour

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
    initializingClients.delete(userId);
    return c.json({ success: true });
});

app.post('/send/:userId', async (c) => {
    const userId = c.req.param('userId');
    const { to, message, mediaUrl } = await c.req.json();
    if (!to || !message) {
        return c.json({ success: false, error: 'Both `to` and `message` are required' }, 422);
    }
    const data = await getOrCreateClient(userId);

    if (data.state !== 'AUTHENTICATED' || !data.ready) {
        return c.json({ success: false, error: 'User not authenticated' }, 401);
    }

    try {
        const chatId = to.includes('@c.us') ? to : `${to}@c.us`;
        await sendMessageWithRetry(data.client, data, chatId, message, mediaUrl);

        data.lastUsed = Date.now();
        return c.json({ success: true });
    } catch (error: any) {
        console.error(`Send error for user ${userId}:`, error);
        return c.json({ success: false, error: error.message }, 500);
    }
});


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
