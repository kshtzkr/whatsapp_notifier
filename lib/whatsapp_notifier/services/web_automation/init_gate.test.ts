import { test, expect, describe } from 'bun:test';
import { InitGate } from './init_gate';

describe('InitGate', () => {
    test('grants up to max immediately, queues the rest', async () => {
        const gate = new InitGate(2);
        const r1 = await gate.acquire();
        const r2 = await gate.acquire();
        expect(gate.activeCount).toBe(2);

        let thirdGranted = false;
        const p3 = gate.acquire().then((r) => { thirdGranted = true; return r; });

        // Third stays queued until a slot frees.
        await Promise.resolve();
        expect(thirdGranted).toBe(false);
        expect(gate.waitingCount).toBe(1);

        r1();
        const r3 = await p3;
        expect(thirdGranted).toBe(true);
        expect(gate.activeCount).toBe(2); // r1 freed, r3 took its place
        expect(gate.waitingCount).toBe(0);

        r2();
        r3();
        expect(gate.activeCount).toBe(0);
    });

    test('release is idempotent — double-calling never drifts the count', async () => {
        const gate = new InitGate(1);
        const r1 = await gate.acquire();
        expect(gate.activeCount).toBe(1);

        r1();
        r1(); // no-op
        r1(); // no-op
        expect(gate.activeCount).toBe(0);

        // A queued waiter is still served exactly once despite the extra releases.
        const a = await gate.acquire();
        expect(gate.activeCount).toBe(1);
        a();
        expect(gate.activeCount).toBe(0);
    });

    test('serves queued waiters in FIFO order', async () => {
        const gate = new InitGate(1);
        const order: number[] = [];
        const first = await gate.acquire();

        const p2 = gate.acquire().then((r) => { order.push(2); return r; });
        const p3 = gate.acquire().then((r) => { order.push(3); return r; });

        first();
        const r2 = await p2;
        r2();
        const r3 = await p3;
        r3();

        expect(order).toEqual([2, 3]);
    });

    test('treats max < 1 as 1', async () => {
        const gate = new InitGate(0);
        const r = await gate.acquire();
        expect(gate.activeCount).toBe(1);
        let second = false;
        gate.acquire().then(() => { second = true; });
        await Promise.resolve();
        expect(second).toBe(false);
        r();
    });
});
