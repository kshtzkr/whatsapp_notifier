import { test, expect, describe } from 'bun:test';
import {
    newCounters,
    renderMetrics,
    isWsEndpointTimeout,
    healthSnapshot,
    type Counters,
    type MetricClient,
} from './metrics';

describe('newCounters', () => {
    test('starts every counter at zero', () => {
        expect(newCounters()).toEqual({
            init_failures_total: 0,
            ws_endpoint_timeouts_total: 0,
            init_timeouts_total: 0,
            auth_failures_total: 0,
            disconnects_total: 0,
        });
    });
});

describe('isWsEndpointTimeout', () => {
    test('matches the Chromium crash-loop signatures', () => {
        expect(isWsEndpointTimeout('Timed out 30000 ms while waiting for the WS endpoint URL to appear in stdout!')).toBe(true);
        expect(isWsEndpointTimeout('Runtime.evaluate timed out. Increase the protocolTimeout')).toBe(true);
    });

    test('ignores unrelated errors', () => {
        expect(isWsEndpointTimeout('Some other failure')).toBe(false);
    });
});

describe('renderMetrics', () => {
    test('renders zeroed gauges + counters for an empty service', () => {
        const out = renderMetrics(new Map(), newCounters(), 0);

        expect(out).toContain('# TYPE whatsapp_active_sessions gauge');
        expect(out).toContain('whatsapp_active_sessions 0');
        expect(out).toContain('whatsapp_authenticated_sessions 0');
        expect(out).toContain('whatsapp_ready_sessions 0');
        expect(out).toContain('whatsapp_qr_pending 0');
        expect(out).toContain('# TYPE whatsapp_init_failures_total counter');
        expect(out).toContain('whatsapp_ws_endpoint_timeouts_total 0');
        expect(out).toContain('whatsapp_service_uptime_seconds 0');
        // No per-user state series when there are no clients.
        expect(out).not.toContain('whatsapp_client_state{');
    });

    test('aggregates session state and emits per-user state series', () => {
        const clients = new Map<string, MetricClient>([
            ['1', { state: 'AUTHENTICATED', qr: null, ready: true }],
            ['2', { state: 'INITIALIZING', qr: null, ready: false }],
            ['3', { state: 'QR_REQUIRED', qr: 'data:image/png;base64,xxx', ready: false }],
        ]);
        const counters: Counters = {
            init_failures_total: 4,
            ws_endpoint_timeouts_total: 2,
            init_timeouts_total: 1,
            auth_failures_total: 3,
            disconnects_total: 5,
        };

        const out = renderMetrics(clients, counters, 86400);

        expect(out).toContain('whatsapp_active_sessions 3');
        expect(out).toContain('whatsapp_authenticated_sessions 1');
        expect(out).toContain('whatsapp_ready_sessions 1');
        expect(out).toContain('whatsapp_qr_pending 1');

        // user 1 is AUTHENTICATED (1) and not any other state (0).
        expect(out).toContain('whatsapp_client_state{user_id="1",state="AUTHENTICATED"} 1');
        expect(out).toContain('whatsapp_client_state{user_id="1",state="INITIALIZING"} 0');
        // user 2 is INITIALIZING.
        expect(out).toContain('whatsapp_client_state{user_id="2",state="INITIALIZING"} 1');
        // every client emits one line per state (4 states x 3 clients).
        const stateLines = out.split('\n').filter((l) => l.startsWith('whatsapp_client_state{'));
        expect(stateLines.length).toBe(12);

        // counters reflected verbatim.
        expect(out).toContain('whatsapp_init_failures_total 4');
        expect(out).toContain('whatsapp_ws_endpoint_timeouts_total 2');
        expect(out).toContain('whatsapp_init_timeouts_total 1');
        expect(out).toContain('whatsapp_auth_failures_total 3');
        expect(out).toContain('whatsapp_disconnects_total 5');
        expect(out).toContain('whatsapp_service_uptime_seconds 86400');
    });

    test('escapes special characters in the user_id label', () => {
        const clients = new Map<string, MetricClient>([
            ['a"b\\c', { state: 'DISCONNECTED', qr: null, ready: false }],
        ]);

        const out = renderMetrics(clients, newCounters(), 1);

        expect(out).toContain('whatsapp_client_state{user_id="a\\"b\\\\c",state="DISCONNECTED"} 1');
    });
});

describe('healthSnapshot', () => {
    test('empty service: ok with zero sessions', () => {
        expect(healthSnapshot(new Map(), 0)).toEqual({ ok: true, uptime_s: 0, sessions: 0, ready: 0 });
    });

    test('counts ready clients out of all in-memory sessions', () => {
        const clients = new Map<string, MetricClient>([
            ['1', { state: 'AUTHENTICATED', qr: null, ready: true }],
            ['2', { state: 'QR_REQUIRED', qr: 'data:image/png;base64,xxx', ready: false }],
            ['3', { state: 'INITIALIZING', qr: null }],
        ]);

        expect(healthSnapshot(clients, 123)).toEqual({ ok: true, uptime_s: 123, sessions: 3, ready: 1 });
    });
});
