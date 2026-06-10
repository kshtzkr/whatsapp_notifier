// Session-existence helpers (pure, unit-testable — see sessions.test.ts).
//
// Kept separate from index.ts (which calls Bun.serve() at import time) so the
// route gating logic can be tested without booting the server or
// whatsapp-web.js.

import { existsSync } from 'fs';

// True when the user has a live in-memory client OR a persisted LocalAuth
// session dir on disk (i.e. they paired at some point and can plausibly be
// authenticated). Routes that only *use* an existing pairing — POST /send,
// GET /inbound — gate on this so a request for a never-paired user can't
// spawn a full Chromium client that parks in QR_REQUIRED forever. The pairing
// routes (GET /qr, GET /status) must NOT use this gate: creating the client
// is exactly what pairing needs.
export function hasPairedSession(
    userId: string,
    liveClients: { has(userId: string): boolean },
    sessionDirFor: (userId: string) => string
): boolean {
    return liveClients.has(userId) || existsSync(sessionDirFor(userId));
}
