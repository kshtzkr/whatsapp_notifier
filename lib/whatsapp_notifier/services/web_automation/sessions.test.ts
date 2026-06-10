import { test, expect, describe, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { hasPairedSession, InitRetryLimiter } from './sessions';

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

describe('InitRetryLimiter', () => {
    test('allows maxRetries retries, then refuses', () => {
        const limiter = new InitRetryLimiter(2);
        expect(limiter.shouldRetry('7')).toBe(true);   // retry 1
        expect(limiter.attemptsFor('7')).toBe(1);
        expect(limiter.shouldRetry('7')).toBe(true);   // retry 2
        expect(limiter.attemptsFor('7')).toBe(2);
        expect(limiter.shouldRetry('7')).toBe(false);  // budget spent
    });

    test('refusing clears the counter so a later cycle starts fresh', () => {
        const limiter = new InitRetryLimiter(1);
        expect(limiter.shouldRetry('7')).toBe(true);
        expect(limiter.shouldRetry('7')).toBe(false);
        expect(limiter.attemptsFor('7')).toBe(0);
        expect(limiter.shouldRetry('7')).toBe(true);   // fresh budget
    });

    test('reset clears the budget (ready / destroy paths)', () => {
        const limiter = new InitRetryLimiter(1);
        expect(limiter.shouldRetry('7')).toBe(true);
        limiter.reset('7');
        expect(limiter.shouldRetry('7')).toBe(true);
    });

    test('budgets are per user', () => {
        const limiter = new InitRetryLimiter(1);
        expect(limiter.shouldRetry('a')).toBe(true);
        expect(limiter.shouldRetry('b')).toBe(true);
        expect(limiter.shouldRetry('a')).toBe(false);
        expect(limiter.shouldRetry('b')).toBe(false);
    });
});
