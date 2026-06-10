# Changelog

## [0.6.0] - 2026-06-10

The gem is now the single source of the Bun + Hono + whatsapp-web.js service:
`bundle exec whatsapp_notifier service` runs it straight from the gem, and the
published package finally ships everything the service needs (and nothing it
does not).

### Service
- Vendored the full service source (`index.ts`, `inbound.ts`, `init_gate.ts`,
  `metrics.ts`, `sessions.ts`, `package.json`, `bun.lock`) into the gem; the
  package excludes `node_modules` and browser caches — platform-native
  binaries are rebuilt on the host via `bun install`.
- `GET /inbound/:userId` two-way reply capture now ships in the published gem
  (pairs with `WhatsAppNotifier.fetch_inbound`; at-least-once, hosts dedupe on
  `message_id`).
- New `GET /health`: cheap, side-effect-free liveness probe
  (`{ ok, uptime_s, sessions, ready }`). The old service had no health route,
  so platform probes (Azure) 404'd and reported the service down.
- Fast-reject sends/polls for never-paired users: `POST /send` answers 401 and
  `GET /inbound` answers empty when the user has no live client and no saved
  session — previously such a request booted a Chromium that parked in
  QR_REQUIRED forever. `GET /qr` / `GET /status` still create clients (the
  pairing path).
- Reconnect backfill can re-open `@lid`-keyed chats: known senders' `@lid`
  aliases join the outbound-target allowlist and chat resolution falls back to
  the contact, so disconnect-window replies from privacy-number accounts are
  no longer lost.
- `client.initialize()` retries are bounded (2 per user, reset on ready or
  destroy) and a pending retry is skipped after logout wipes the session dir —
  no more infinite relaunch loops or post-logout QR zombies.
- Non-ready clients idle longer than 30 minutes are reaped
  (`WHATSAPP_UNREADY_REAP_MS`, default 1800000); ready clients keep the 72h
  rule. The on-disk session survives, so a half-paired user can retry the QR.
- Prometheus `GET /metrics`, the bounded init gate
  (`WHATSAPP_MAX_CONCURRENT_INITS`) and the INITIALIZING watchdog
  (`WHATSAPP_INIT_TIMEOUT_MS`) are included with the vendored service.

### CLI & generator
- `whatsapp_notifier service --port` now beats a pre-set `PORT` env (the flag
  used to be silently ignored); Chromium autodetect also accepts
  `/usr/bin/chromium-browser`.
- `rails g whatsapp_notifier:install_service` ejects an explicit file list
  instead of recursively copying the live service dir (which dragged
  `node_modules`, session caches and test files into the host app).

## [0.5.1] - 2026-06-09

- Capture inbound replies delivered from `@lid` privacy ids by resolving them
  to the real phone `@c.us` via the contact.
- Switch capture to the `message_create` event (fires reliably on
  linked/multi-device sessions), dedupe the listener, drop bodyless system
  events (`e2e_notification`, `call_log`, ...), and scope the reconnect
  backfill to chats we actually messaged.

## [0.5.0] - 2026-06-05

- Explicit per-user logout: `POST /logout/:userId`, `WhatsAppNotifier.logout`
  and `DELETE /whatsapp/logout` on the engine — disconnects and wipes the
  saved session so the next connect starts fresh.
- Service self-healing: recycle clients stuck INITIALIZING, clear stale
  Chromium `SingletonLock` files on launch, and optional WhatsApp Web build
  pinning via `WWEBJS_WEB_VERSION`.

## [0.4.0] - 2026-05-28

- Inbound capture: buffer customer replies on the service and drain them via
  `GET /inbound/:userId` / `WhatsAppNotifier.fetch_inbound`.
- Mountable engine refinements and test-suite fixes (runtime ActiveJob check).
