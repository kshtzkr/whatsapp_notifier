# Changelog

## [0.7.0] - 2026-06-11

Inbound media: the service now downloads customer images, voice notes and
documents to disk and serves them back to the host on demand.

### Upgrade notes
- **Hosts that monkey-patch `WhatsAppNotifier::WebAdapter#request`**: the
  shared JSON path now carries the `DELETE` verb (`delete_media`) and attaches
  `X-WA-Token` when `WHATSAPP_WEBHOOK_TOKEN` is set — a patch that only
  handles `POST`/`GET` or drops headers will break the new media calls against
  a token-guarded service. Better: retire the patch. The adapter now honors
  `https://` service URLs natively on BOTH request paths (`use_ssl` follows
  the URL scheme; previously a https URL silently spoke plaintext), which was
  the usual reason such patches existed.
- **`POST /logout` now also wipes the user's downloaded inbound media**
  (`<SESSION_DIR>/media/<userId>/`) along with the session dir and queued
  replies. Media stored under a pairing belongs to that pairing — previously
  it stayed on disk (and fetchable via `GET /media`) for up to the 48h TTL
  after the operator severed the pairing.

### Service
- New `media.ts` store: bytes live at `<SESSION_DIR>/media/<userId>/<messageId>`
  with a JSON sidecar at `<messageId>~meta.json` (`mime`, `filename`, `size`,
  `capturedAt`), so cached media survives restarts that wipe the in-memory
  inbound queues. Both ids are sanitized to `[A-Za-z0-9@._-]` and resolved
  paths are confined to the media root (path-traversal guarded on both ends);
  the `~` in the sidecar suffix sits outside the sanitize charset, so a
  message id ending in `.json` can never collide with a sidecar.
- Download policy: images, audio and voice notes (`ptt`) up to 16MB; documents
  up to `WHATSAPP_MEDIA_MAX_BYTES` (default 25MB); stickers, videos and
  view-once media are never downloaded (`mediaError: unsupported_type`).
  Oversize media reports `too_large`; a full cache reports `disk_full`.
- The capture pipeline resolves the sender (contact lookup + `@lid` → phone)
  FIRST and drops unresolvable `@lid` messages before any download, then
  resolves media BEFORE enqueue + webhook: declared-size policy pre-check,
  30s-bounded `downloadMedia()` (vanished media → `expired`, errors/timeouts
  → `download_failed`), post-download size re-check, then persist. A kept
  message always reaches the host — every media failure mode just arrives
  without bytes (`mediaStatus: 'unavailable'` + a typed `mediaError`). The
  reconnect backfill short-circuits on media already stored instead of
  re-downloading.
- Inbound payloads gain OPTIONAL `hasMedia` / `mediaStatus` / `mediaError` /
  `mediaMime` / `mediaFilename` / `mediaSize` / `senderName` (best-effort
  contact display name). Keys appear only when carried, so the wire format is
  byte-compatible with 0.6.0 in both directions: a 0.6.0 host simply ignores
  the extras, and a 0.7.0 host detects a 0.6.0 service by the absence of
  `hasMedia`.
- New routes `GET/DELETE /media/:userId/:messageId`: GET serves the raw bytes
  with `Content-Type` / `Content-Length` / `Content-Disposition` from the
  sidecar and answers the same `404 {"error":"not_found"}` for unknown, swept
  and invalid ids; DELETE is idempotent `{"success":true}`. Both routes
  timing-safe-check `X-WA-Token` — enforced only when
  `WHATSAPP_WEBHOOK_TOKEN` is set (set it in production) — and never create a
  WhatsApp client (same fast-reject rule as `GET /inbound`).
- TTL sweep on the existing 5-minute reaper interval: media older than
  `WHATSAPP_MEDIA_TTL_MS` (default 48h) is evicted and the disk accounting for
  the `WHATSAPP_MEDIA_MAX_DISK_BYTES` cap (default 5GB) is refreshed.
- `POST /logout` wipes the user's stored media (see upgrade notes) — sanitized
  id, root-contained path, disk-cap accounting refreshed.
- Malformed limit envs (`WHATSAPP_MEDIA_TTL_MS` / `WHATSAPP_MEDIA_MAX_BYTES` /
  `WHATSAPP_MEDIA_MAX_DISK_BYTES`) fall back to their defaults instead of
  parsing to `NaN` and silently disabling the sweep and the caps.

### Adapter & Ruby API
- `fetch_inbound` passes the new keys through as `has_media` / `media_status`
  / `media_error` / `media_mime` / `media_filename` / `media_size` /
  `sender_name` — only when present on the wire, so hosts can key-gate ingest
  on `has_media` and stay no-op against a 0.6.0 service mid-rollout.
- New `WhatsAppNotifier.fetch_media(message_id:, metadata:)` →
  `{ body:, mime:, filename:, size: }`, or `nil` when the service has no copy
  (404). Runs on a dedicated binary HTTP path (the JSON-parsing `#request` is
  bypassed so payloads cannot be corrupted; 60s read timeout; sends
  `X-WA-Token` when `WHATSAPP_WEBHOOK_TOKEN` is set).
- New `WhatsAppNotifier.delete_media(message_id:, metadata:)` → host calls it
  after attaching the bytes; idempotent. A 404 (0.6.0 service mid-rollout, or
  media already evicted) degrades to `{ success: false }` instead of raising —
  the same graceful-degradation matrix as `fetch_media`'s `nil`. The shared
  JSON request path now supports DELETE and attaches `X-WA-Token` when
  configured.
- Both adapter request paths (JSON control plane + binary media fetch) pass
  `use_ssl` from the URL scheme, so `https://` service URLs are honored
  natively.
- Provider/Client/module delegation guard the new adapter capabilities with
  the same `respond_to?` idiom as `fetch_inbound`, and
  `rails g whatsapp_notifier:install_service` ejects `media.ts`.

### New environment variables
- `WHATSAPP_MEDIA_TTL_MS` — media cache lifetime (default 48h).
- `WHATSAPP_MEDIA_MAX_BYTES` — per-document download cap (default 25MB).
- `WHATSAPP_MEDIA_MAX_DISK_BYTES` — total media cache cap (default 5GB).
- `WHATSAPP_WEBHOOK_TOKEN` — now also guards the `/media` routes.

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
  rule. The cleanup sweep runs every 5 minutes (a cheap O(clients) scan), so
  reaping lands within ~5 minutes of the limit instead of the 30-90 min an
  hourly sweep allowed.
- Abandoned pairing visits can no longer defeat the fast-reject gate:
  LocalAuth creates the session dir on the first `initialize()` — before any
  QR scan — so a single abandoned `GET /qr` used to mark the user paired
  forever. Now only ready clients refresh `lastUsed` on access (a QR zombie
  looks idle no matter how much `/send` traffic hits it), and reaping a
  client that never authenticated also removes its credential-less session
  dir. Sessions that authenticated at least once keep their dir, so a
  wedge-reaped user reconnects without a new QR.
- `POST /logout` also clears the user's buffered inbound replies and cached
  outbound-target allowlist: the gated `GET /inbound` answers empty for
  unpaired users without draining, so messages captured between the last poll
  and the logout would otherwise sit in memory and replay into the wrong
  pairing if the same userId paired again.
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
