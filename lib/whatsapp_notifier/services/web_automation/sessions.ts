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

// Idle limit the cleanup sweep applies to a client. Ready clients earn the
// long limit; everything else (QR_REQUIRED zombies, wedged AUTHENTICATED-but-
// never-ready, DISCONNECTED stragglers) gets the short one — an abandoned
// pairing screen must not hold a full Chromium for 3 days. INITIALIZING is
// excluded from the short limit because the init watchdog/init gate own that
// phase: a client can sit in the launch queue legitimately.
export function reapLimitMs(
    client: { ready?: boolean; state: string },
    readyLimitMs: number,
    unreadyLimitMs: number
): number {
    if (client.ready || client.state === 'INITIALIZING') return readyLimitMs;
    return unreadyLimitMs;
}

// Per-user budget for re-running client.initialize() after a failure.
// Unbounded retries turn one persistently-broken session into an infinite
// Chromium relaunch loop. The budget resets when the client reaches 'ready'
// or is explicitly destroyed, so a later, user-triggered pairing attempt
// starts fresh.
export class InitRetryLimiter {
    private readonly counts = new Map<string, number>();

    constructor(private readonly maxRetries: number) {}

    // Consume one retry. True while the user still has budget; false (and the
    // counter clears, ready for a future fresh cycle) once it is spent.
    shouldRetry(userId: string): boolean {
        const attempts = (this.counts.get(userId) || 0) + 1;
        if (attempts > this.maxRetries) {
            this.counts.delete(userId);
            return false;
        }
        this.counts.set(userId, attempts);
        return true;
    }

    attemptsFor(userId: string): number {
        return this.counts.get(userId) || 0;
    }

    reset(userId: string) {
        this.counts.delete(userId);
    }
}
