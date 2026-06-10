// Prometheus metrics for the WhatsApp service.
//
// Kept in a separate, side-effect-free module so the exposition logic can be
// unit-tested without importing whatsapp-web.js or starting the Bun server
// (index.ts calls Bun.serve() at import time). index.ts owns the live `clients`
// Map + a Counters instance and simply calls renderMetrics() in its /metrics route.

export type ClientState = 'INITIALIZING' | 'QR_REQUIRED' | 'AUTHENTICATED' | 'DISCONNECTED';

// The subset of ClientData that metrics need. ReadonlyMap keeps the param
// covariant so index.ts can pass its richer Map<string, ClientData> directly.
export interface MetricClient {
    state: ClientState;
    qr: string | null;
    ready?: boolean;
}

export interface Counters {
    init_failures_total: number;        // client.initialize() rejected
    ws_endpoint_timeouts_total: number; // Chromium never produced a WS endpoint (crash-loop signature)
    init_timeouts_total: number;        // watchdog recycled a stuck-INITIALIZING client
    auth_failures_total: number;        // auth_failure event
    disconnects_total: number;          // disconnected event
}

export function newCounters(): Counters {
    return {
        init_failures_total: 0,
        ws_endpoint_timeouts_total: 0,
        init_timeouts_total: 0,
        auth_failures_total: 0,
        disconnects_total: 0,
    };
}

// True when an init error is the Chromium-launch crash-loop signature we keep
// hitting under memory pressure (see incident history). Drives a dedicated
// counter so the dashboard can alert on F1 specifically.
export function isWsEndpointTimeout(message: string): boolean {
    return message.includes('WS endpoint URL') ||
        message.includes('Runtime.evaluate timed out');
}

// Cheap JSON body for GET /health: reads only the in-memory clients map —
// never creates or touches a client — so load balancer / Azure probes can hit
// it every few seconds without side effects.
export function healthSnapshot(clients: ReadonlyMap<string, MetricClient>, uptimeSeconds: number) {
    let ready = 0;
    for (const data of clients.values()) {
        if (data.ready) ready += 1;
    }
    return { ok: true as const, uptime_s: uptimeSeconds, sessions: clients.size, ready };
}

function escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// Render the Prometheus text-exposition (version 0.0.4) for the current state.
export function renderMetrics(
    clients: ReadonlyMap<string, MetricClient>,
    counters: Counters,
    uptimeSeconds: number,
): string {
    const ALL_STATES: ClientState[] = ['INITIALIZING', 'QR_REQUIRED', 'AUTHENTICATED', 'DISCONNECTED'];

    let active = 0;
    let authenticated = 0;
    let ready = 0;
    let qrPending = 0;
    const stateLines: string[] = [];

    for (const [userId, data] of clients) {
        active += 1;
        if (data.state === 'AUTHENTICATED') authenticated += 1;
        if (data.ready) ready += 1;
        if (data.qr) qrPending += 1;
        const label = escapeLabel(userId);
        for (const state of ALL_STATES) {
            stateLines.push(`whatsapp_client_state{user_id="${label}",state="${state}"} ${data.state === state ? 1 : 0}`);
        }
    }

    const gauge = (name: string, help: string, value: number) => [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} gauge`,
        `${name} ${value}`,
    ];
    const counter = (name: string, help: string, value: number) => [
        `# HELP ${name} ${help}`,
        `# TYPE ${name} counter`,
        `${name} ${value}`,
    ];

    return [
        ...gauge('whatsapp_active_sessions', 'WhatsApp clients currently held in memory.', active),
        ...gauge('whatsapp_authenticated_sessions', 'Clients in the AUTHENTICATED state.', authenticated),
        ...gauge('whatsapp_ready_sessions', 'Clients whose WhatsApp Web store finished hydrating (ready=true).', ready),
        ...gauge('whatsapp_qr_pending', 'Clients currently showing a QR awaiting scan.', qrPending),
        '# HELP whatsapp_client_state Per-user client state (1 for the active state, else 0).',
        '# TYPE whatsapp_client_state gauge',
        ...stateLines,
        ...counter('whatsapp_init_failures_total', 'client.initialize() rejections.', counters.init_failures_total),
        ...counter('whatsapp_ws_endpoint_timeouts_total', 'Chromium launches that never produced a WS endpoint (crash-loop signature).', counters.ws_endpoint_timeouts_total),
        ...counter('whatsapp_init_timeouts_total', 'Clients recycled by the INITIALIZING watchdog.', counters.init_timeouts_total),
        ...counter('whatsapp_auth_failures_total', 'auth_failure events.', counters.auth_failures_total),
        ...counter('whatsapp_disconnects_total', 'disconnected events.', counters.disconnects_total),
        ...gauge('whatsapp_service_uptime_seconds', 'Seconds since the service process started.', uptimeSeconds),
        '',
    ].join('\n');
}
