// Bounded-concurrency gate for Chromium launches.
//
// whatsapp-web.js spawns a full Chromium (~300-400MB + CPU spike) per
// client.initialize(). When many clients cold-launch at once — e.g. every
// operator reconnecting after a VM reboot — the simultaneous launches exhaust
// RAM/CPU and crash-loop on "WS endpoint URL" timeouts. This gate caps how many
// initialize() run concurrently; the rest queue (FIFO) and start as slots free.
//
// acquire() resolves with a release function that is idempotent: calling it more
// than once is a no-op, so wiring release into several lifecycle handlers
// (qr/ready/auth_failure/init-failure/watchdog/destroy) can never double-free a
// slot or let the active count drift. Kept dependency-free + side-effect-free so
// it can be unit-tested without importing whatsapp-web.js.

export class InitGate {
    private readonly max: number;
    private active = 0;
    private readonly queue: Array<() => void> = [];

    constructor(max: number) {
        this.max = Math.max(1, Math.floor(max));
    }

    // Acquire a launch slot. Resolves immediately if under the cap, otherwise
    // when an earlier holder releases. The resolved function frees the slot.
    acquire(): Promise<() => void> {
        return new Promise((resolve) => {
            const grant = () => {
                this.active += 1;
                let released = false;
                resolve(() => {
                    if (released) return; // idempotent — double release is a no-op
                    released = true;
                    this.active -= 1;
                    const next = this.queue.shift();
                    if (next) next();
                });
            };

            if (this.active < this.max) {
                grant();
            } else {
                this.queue.push(grant);
            }
        });
    }

    get activeCount(): number {
        return this.active;
    }

    get waitingCount(): number {
        return this.queue.length;
    }
}
