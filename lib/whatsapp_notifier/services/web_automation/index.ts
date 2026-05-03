import { Client, LocalAuth } from 'whatsapp-web.js';
import { Hono } from 'hono';
import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { toDataURL } from 'qrcode';

const app = new Hono();
const port = Number(process.env.PORT || 3001);
const SESSION_BASE_DIR = process.env.WHATSAPP_SESSION_DIR || '/whatsapp_data';
const BROWSER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH;

// Multi-user client management
interface ClientData {
    client: Client;
    state: 'INITIALIZING' | 'QR_REQUIRED' | 'AUTHENTICATED' | 'DISCONNECTED';
    qr: string | null;
    lastUsed: number;
    isDestroying?: boolean;
    ready?: boolean;
}

const clients = new Map<string, ClientData>();
const initializingClients = new Set<string>();

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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu'
            ],
            ...(BROWSER_EXECUTABLE_PATH ? { executablePath: BROWSER_EXECUTABLE_PATH } : {})
        }
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
        console.log(`Client is READY for User ${userId}`);
    });

    client.on('authenticated', () => {
        clientData.state = 'AUTHENTICATED';
        clientData.ready = false;
        console.log(`AUTHENTICATED for User ${userId}`);
    });

    client.on('auth_failure', (msg) => {
        clientData.state = 'DISCONNECTED';
        clientData.ready = false;
        console.error(`AUTHENTICATION FAILURE for User ${userId}`, msg);
    });

    client.on('disconnected', (reason) => {
        clientData.state = 'DISCONNECTED';
        clientData.ready = false;
        console.log(`User ${userId} was logged out`, reason);
        destroyClient(userId).catch(console.error);
    });

    client.initialize().catch(async (err) => {
        console.error(`Initialization failed for user ${userId}:`, err.message || err);
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

    initializingClients.delete(userId);
    return clientData;
}

async function destroyClient(userId: string) {
    const data = clients.get(userId);
    if (data && !data.isDestroying) {
        data.isDestroying = true;
        console.log(`Destroying WhatsApp client for User: ${userId}`);
        try {
            // Unregister listeners to prevent loops or double-destroys
            data.client.removeAllListeners();
            await data.client.destroy();
        } catch (e) {
            console.error(`Error destroying client for ${userId}`, e);
        }
        clients.delete(userId);
        // Session data is preserved on disk for auto-reconnect
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
