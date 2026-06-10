import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasPairedSession } from './sessions';

const root = mkdtempSync(join(tmpdir(), 'wa-sessions-'));
const dirFor = (userId: string) => join(root, `session-user-${userId}`);

afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('hasPairedSession', () => {
    test('false when the user has no live client and no session dir', () => {
        expect(hasPairedSession('default', new Map(), dirFor)).toBe(false);
    });

    test('true when a live client exists (even without a session dir yet)', () => {
        const clients = new Map([['7', {}]]);
        expect(hasPairedSession('7', clients, dirFor)).toBe(true);
    });

    test('true when a session dir survives on disk (paired user after restart)', () => {
        mkdirSync(dirFor('42'), { recursive: true });
        expect(hasPairedSession('42', new Map(), dirFor)).toBe(true);
    });

    test('scoped per user — one paired user does not unlock another', () => {
        mkdirSync(dirFor('paired'), { recursive: true });
        const clients = new Map([['live', {}]]);
        expect(hasPairedSession('paired', clients, dirFor)).toBe(true);
        expect(hasPairedSession('live', clients, dirFor)).toBe(true);
        expect(hasPairedSession('other', clients, dirFor)).toBe(false);
    });
});
