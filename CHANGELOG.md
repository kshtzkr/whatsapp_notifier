# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.9.3] - 2026-08-13

Stops the service inventing phone numbers for privacy-id (`@lid`) chats. Seen
live in production: CMS inbox rows titled `128539848396…` — an id that belongs
to no customer, cannot be dialled, and quietly forked a second thread for a
customer who already had one.

### Fixed

- **The inbound leg no longer mints a phone out of an `@lid`'s own digits.**
  For an `@lid` sender the contact object reports `id.user` as the privacy id
  itself, and the inbound leg trusted it unconditionally — forwarding
  `<lid>@c.us` as though it were a phone number. The operator-sent (fromMe) leg
  has carried the guard since 0.8.x ("an @lid contact id would otherwise mint a
  bogus 'phone' out of the privacy id's own digits"); only the inbound leg was
  missing it, so every privacy-keyed chat that arrived customer-first was
  threaded onto a fabricated number.
- **History replay resolves the customer's leg too.** `replayHistory` resolved
  only `fromMe` items, so the customer's own messages in an `@lid`-keyed chat
  were replayed carrying the raw privacy id at `from` — the same defect by a
  second route. Both legs now resolve, or the item is skipped.
- **A poisoned alias can no longer be stored, or survive a restart.**
  `rememberLidAlias` refuses any mapping that is not a `@c.us` id with digits
  different from the `@lid`'s own, and `loadLidAliases` drops such entries when
  reading `lid_aliases.json` — so a service already poisoned in production
  recovers by itself instead of routing the operator's replies into a phantom
  thread forever. The purge reaches disk on the next alias write.

### Changed

- **One `@lid` → phone resolver, shared by all three call sites.** The inbound
  leg, the fromMe leg and history replay had grown separate copies that
  drifted; `resolveLidToPhone` replaces them. It tries the learned alias map,
  then the contact the caller already fetched, then one live lookup, and every
  candidate must pass the same `isUsablePhoneFor` invariant.
- **Live lookup now uses `getContactLidAndPhone`** (whatsapp-web.js 1.34.7's
  purpose-built LID↔PN resolver), falling back to `getContactById`. This
  recovers a phone even when the contact object carries nothing but the LID —
  the case that previously ended in a fabricated number.

### Added

- **`senderLid` on the inbound wire.** Present only for a privacy-keyed chat,
  carrying the `<digits>@lid` the counterparty was resolved FROM. Additive:
  older hosts ignore the key. Mapped to `sender_lid` by the Ruby adapter.
- **`GET /contacts/lid/:userId?lid=…` → `{ pn }`**, plus
  `WhatsAppNotifier.resolve_lid(lid:)`. Resolves one privacy id to the phone
  behind it so a host can repair conversations it already keyed on an
  unresolved `@lid`. Same `X-WA-Token` + paired-and-ready gate as `/chats` and
  `/history`. A privacy id with no recoverable phone answers 200 with
  `pn: null` — a real answer, not a 404.

## [0.9.2] - 2026-08-06

Targets the fresh-pairing logout loop: a phone scans the QR and shows the
device as linked, but WhatsApp terminates the new session seconds after
`ready`, the client recycles, and the operator is bounced back to a QR
screen indefinitely. Service-side (TypeScript) only — no Ruby API changes.

### Changed

- **whatsapp-web.js 1.34.6 → 1.34.7.** Picks up the store-injection rework
  (moduleraid removed), the LID-handling fixes in `getContact` /
  `getChatModel`, and the `disconnected`-event fixes — the release most
  relevant to fresh sessions being force-logged-out right after pairing
  while older, already-paired sessions keep working.

### Fixed

- **Stale QR served after scan.** The `authenticated` event now clears the
  stored QR. Previously the consumed (already-scanned, no-longer-valid) code
  kept being served through the authenticated→ready sync window, so host
  pairing modals kept telling the operator to scan an image that could
  never work again.

## [0.9.1] - 2026-07-31

Closes the last unwatched gap in the session lifecycle, and tells the host the
moment a session comes back. Service-side (TypeScript) only — no Ruby API
changes.

### Added

- **Ready watchdog.** The INITIALIZING watchdog stands down when
  `authenticated` fires, so a session that re-authenticated from disk but
  whose WhatsApp Web store never hydrated (`ready` never fires — RAM pressure,
  a mid-write kill, a slow web.whatsapp.com) wedged serving `qr=null` +
  `authenticated=false` until the 30-minute idle reaper. The service now
  recycles such a client after `WHATSAPP_READY_TIMEOUT_MS` (default 180000);
  the on-disk session survives, so the next status poll reconnects without a
  new QR. Recycles are counted in the new `whatsapp_ready_timeouts_total`
  metric.
- **`session_ready` webhook event.** When a client reaches `ready`, the
  service POSTs `{userId, event: "session_ready"}` to the configured
  `WHATSAPP_WEBHOOK_URL` (same `X-WA-Token` auth as message pushes), so hosts
  can resume work they parked on "session down" in realtime instead of on a
  polling tick. Best-effort: hosts that don't know the shape reject it with a
  400 and lose nothing.

## [0.9.0] - 2026-07-30

Two pieces of transport logic that every host was reimplementing now live in
the gem. Both are additive — no existing call changes behaviour.

### Added

- **`WhatsAppNotifier.session_ready?`** — one call for "can this operator send
  right now?". It is `connection_status(...)[:authenticated] == true` with
  transport errors treated as not-ready: an unreachable status endpoint means
  the service is down, so a send could not have succeeded either. Takes
  `user_id:` (sugar for the metadata key) or a full `metadata:` hash.
  `ConfigurationError` is deliberately NOT swallowed — that is a host setup
  mistake, and answering `false` would quietly park every send behind a
  "session down" backoff. Available on `Client` and on any provider, so custom
  providers inherit it.
- **Structured failure codes on `Result#error_code`.** Every send failure used
  to collapse to `:delivery_exception`, which left hosts regexing
  `error_message` to work out whether a retry was safe. Failures now classify
  into a stable vocabulary: `:auth_required`, `:not_on_whatsapp`,
  `:invalid_phone`, `:recipient_unresolved`, `:service_unreachable`,
  `:timeout`, `:rate_limited`, and `:delivery_exception` as the catch-all.
  `WhatsAppNotifier::ErrorCode::ALL` lists them.
  - The split between `:service_unreachable` (connect never opened — the
    message definitely did not go out) and `:timeout` (request sent, answer
    never came — outcome unknown) is the one that matters: only the former is
    safe to auto-retry without risking a double-message.
- **`WhatsAppNotifier::ServiceError`** — raised in place of a bare `RuntimeError`
  for a non-2xx service answer, carrying `#status`. Classification reads the
  status instead of regexing our own message string.
- The adapter now forwards an `errorCode` from the service when one is present,
  so a future service release can name the failure itself and the gem stops
  inferring it from text.

### Compatibility

- `error_message` is untouched, including the `"service request failed (401):
  ..."` wording, so hosts still fingerprinting text keep working while they
  migrate.
- `:delivery_exception` remains the fallback code, so code keying on the
  pre-0.9.0 value still matches every failure the gem cannot classify.
- `ServiceError` subclasses `RuntimeError`, which is what a non-2xx raised
  before, so hosts wrapping media fetches or status polls in
  `rescue RuntimeError` keep catching it. That is why it does not hang off
  `WhatsAppNotifier::Error`.

### Documentation

- README: a `session_ready?` section under "Connecting a number" and a failure
  code table, with a "did the message go out?" column, under "Sending a
  message".
- Rewrote the README with a badge row, table of contents, requirements, an
  explanation of the Ruby-to-Bun service boundary, and sections for the CLI,
  doctor, engine routes, and inbound/media helpers.
- Added `docs/CONFIGURATION.md` with the full configuration reference: every
  Ruby option and every service environment variable, with types and defaults.
- Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and `SECURITY.md`.

## [0.8.2] - 2026-07-10

Production fix: every operator-phone (fromMe) message in an @lid-keyed chat
was silently dropped — two-way sync worked customer→host, but the operator's
side of those conversations never arrived.

- **Resolve @lid chats on the operator-sent (fromMe) leg.** Newer WhatsApp
  keys some 1:1 chats by an @lid privacy id. The inbound leg already
  resolves those senders to the real phone, but `processOwnMessage` dropped
  every fromMe message to an @lid chat unconditionally (`Dropping fromMe
  message to unresolved @lid chat`) — seen live in production (chat
  `125417440686124@lid`: customer messages flowed as `919882536803@c.us`,
  operator replies vanished). The counterparty now resolves in order:
  (1) the learned @lid → phone alias map, recorded whenever any leg
  resolves an @lid; (2) one guarded live `getContactById(<@lid>)` lookup —
  the exact call the inbound leg is proven on — whose hit is learned back
  into the map; (3) only when both fail, the existing logged drop (now
  genuinely rare).
- **Alias map persisted per user** (`lid_aliases.json`, stored next to
  `outbound_targets.json` in the session dir, wiped by `POST /logout`), so
  a service restart doesn't resume dropping operator messages until the
  customer happens to write again.
- **History replay resolves fromMe @lid items too.** `POST /history` for a
  phone whose chat is @lid-keyed now rewrites fromMe counterparties to the
  requested `@c.us` chat id (which IS that @lid's phone) and learns the
  alias, instead of forwarding an unmatchable @lid — so a history sync can
  backfill the operator messages the old drop lost.
- Wire shape unchanged: resolved payloads are indistinguishable from normal
  `@c.us` fromMe events. Hosts need no changes.

## [0.8.1] - 2026-07-10

Two production file-send fixes on the service's `POST /send` path.

- **Accept file-only sends.** `/send` required a non-empty `message` and
  422'd (`Both 'to' and 'message' are required`) any body with a `mediaUrl`
  but no caption — the normal shape for hosts that attach files one-by-one
  with the caption only on the first file. `to` is still always required;
  the body must now carry `message` and/or `mediaUrl`. A caption-less media
  send delivers the file with no caption (the caption key is omitted
  entirely, matching a hand-sent file).
- **`unsafeMime` media downloads.** `MessageMedia.fromUrl` sniffed the MIME
  type from the URL, so extension-less media URLs (e.g. Rails ActiveStorage
  blob/proxy paths) threw `Unable to determine MIME type using URL` and the
  send 500'd. The send path now passes `unsafeMime: true`, trusting the
  response `Content-Type` header instead — this is the service's only
  `fromUrl` call site; inbound/history media use `downloadMedia()` and are
  unaffected.
- Note: `/send` accepts no `filename` field today, so recipient-side
  document names come from whatever `fromUrl` derives. Plumbing an optional
  host-provided `filename` is future work, not part of this patch.

## [0.8.0] - 2026-06-13

Two-way capture: messages the operator sends from the WhatsApp app itself
(phone/web) now reach the host, so threads show BOTH sides of every 1:1
conversation — not just customer replies and platform sends.

### Upgrade notes
- **Deploy order: upgrade the HOST first, then the service.** A 0.8.0
  service paired with a pre-0.8.0 host delivers fromMe payloads the host
  doesn't key-gate on — an operator send in a self-test campaign comes back
  through `/inbound` and is ingested as a phantom customer reply. A host that
  understands `fromMe` is a no-op against a 0.7.0 service, so host → service
  is the safe order.
- **Hosts MUST still dedupe self-echoes on `messageId`** even though the
  service now suppresses its own `/send` echoes (see Service below): the
  suppression registry is in-memory and best-effort, so an echo landing after
  a service restart — or firing before `/send` finished registering its id —
  flows through. The contract is unchanged: store the `messageId` the 0.8.0
  `/send` response returns against your outbound record (unique column), skip
  any fromMe event whose id you already hold, and cover the race where the
  echo beats your commit with an adopt window (match a recent same-body
  outbound record with no id yet and adopt the id onto it instead of creating
  a new message). Note the service's send retry can deliver a message more
  than once upstream (pre-existing behaviour) — the adopt logic should
  tolerate an echo that matches no pending record rather than erroring.
- **Set `WHATSAPP_WEBHOOK_TOKEN` in production.** The new `GET /chats` and
  `POST /history` routes enforce `X-WA-Token` ONLY when that env var is set
  (same opt-in rule as `/media`) — and they expose whole-conversation
  content, not just the caller's own queue. An untokened production service
  serves every paired number's chat list and history to anyone who can reach
  the port.
- Capture now includes operator-sent 1:1 messages on the linked number —
  by design (whole-conversation sync). Groups and status remain excluded by
  the same counterparty jid gate; nothing changes for inbound payloads.

### Service
- `shouldCapture` keeps fromMe messages; every jid gate now validates the
  COUNTERPARTY (`msg.to` for fromMe, `msg.from` otherwise) so the operator's
  own @c.us jid can never vouch for a group/status post. isStatus and the
  textual-type gates apply to both directions unchanged.
- **Self-send echoes are suppressed service-side.** `POST /send` registers
  the sent message id in a per-user, bounded (200 ids), 10-minute-TTL
  in-memory registry; the fromMe capture leg drops registry hits ENTIRELY —
  no media resolution (a media send no longer re-downloads its own
  attachment on the sending Chromium and churns the per-user media cap with
  bytes the host never fetches), no queue slot, no webhook push. Messages
  typed on the phone and reconnect-backfill replays are never in the
  registry and flow through unchanged; hosts keep the id-dedupe for the
  restart gap (see upgrade notes). Logout clears the registry with the rest
  of the pairing state.
- fromMe payloads carry optional `fromMe: true` + `to` (the counterparty chat
  id the host threads on). Keys appear ONLY on operator-sent messages, so
  inbound payloads stay byte-identical to 0.7.0 and hosts key-gate on
  `fromMe` presence. The fallback `messageId` for id-less fromMe messages
  keys on the counterparty (`${to}-${timestamp}`) — the operator's `from` is
  shared by every chat and would collide across same-second sends. The media
  store files id-less fromMe media under the same counterparty key, so the
  bytes stay addressable by the exact id the wire advertised.
- The fromMe leg skips the `senderName` contact lookup (the sender is the
  operator; saves a puppeteer roundtrip per message). Media resolution,
  enqueue and webhook push are shared with the inbound leg — operator-sent
  photos/documents sync through the existing `GET /media` path under the same
  size caps and TTL.
- A fromMe message to a brand-new number allowlists the chat for reconnect
  backfill exactly like a `/send` recipient, so operator-initiated
  conversations survive disconnect windows too. The backfill itself replays
  BOTH directions (`fetchMessages` always returned own messages; the old
  fromMe guard just dropped them).
- fromMe messages to `@lid` privacy chats are dropped with a log: an @lid
  counterparty carries no phone the host can match, and unlike inbound there
  is no contact handle to resolve it through (`getContact()` resolves the
  sender — the operator).
- `POST /send` now returns `{ success: true, messageId }` with the real
  serialized WhatsApp id of the sent message (the echo-dedupe key above), or
  `messageId: null` when the library hands nothing back — never a fabricated
  id, which would match no echo while still occupying the host's unique slot.

### Adapter & Ruby API
- `fetch_inbound` maps the new optional keys as `from_me` / `to` — only when
  present on the wire, mirroring the media-key contract, so hosts stay no-op
  against a pre-0.8.0 service mid-rollout.
- `send_message` prefers the service-issued `messageId` (or `message_id`)
  from the `/send` response as the result's `message_id`, falling back to the
  existing `idempotency_key` / `local-<ts>` fabrication against 0.7.0
  services. `Result#message_id` therefore carries the real WhatsApp id once
  the 0.8.0 service is deployed.
- The ejected service (install generator) now ships `send.ts`.

### Chat history
Sync OLD conversations — chats that predate the pairing — on demand.

- `GET /chats/:userId` lists the paired number's 1:1 chats for discovery:
  `{ success: true, chats: [{ id, name, lastMessageAt }] }`, newest first,
  **capped at the 500 most recent** (a long-lived personal number can hold
  thousands of chats; the host only needs the recent ones to offer for
  syncing). `@c.us` ids only — groups, status and `@lid` privacy chats are
  excluded. `name` is best-effort (null when WhatsApp has none);
  `lastMessageAt` is epoch seconds or null.
- `POST /history/:userId` with `{ chatId, limit }` replays one chat's recent
  messages through the live-capture normalizer and returns them DIRECTLY —
  `{ success: true, messages: [...] }`, oldest first; no queue, no webhook
  (the host ingests the response synchronously). Both directions are
  replayed: operator-sent messages carry `fromMe` + `to` exactly like live
  capture. `chatId` accepts a bare number (normalized to `@c.us` like
  `/send`) and must be a 1:1 id; `limit` is clamped to 1..200 (default 50).
  Messages failing the live `shouldCapture` gate (system events, status) are
  skipped, and the synced chat joins the reconnect-backfill allowlist like a
  `/send` recipient.
- **History media is marked, never downloaded — by design.** Media-typed
  messages return `hasMedia: true, mediaStatus: 'unavailable', mediaError:
  'history'`: bulk-downloading a photo-heavy chat's history would blow the
  media disk caps and stall the session behind sequential downloads. Live
  capture keeps downloading media for everything that arrives after the sync.
- Both routes gate exactly like `POST /send` (paired fast-reject before any
  client exists, then AUTHENTICATED + ready) and additionally enforce
  `X-WA-Token` like `/media` when `WHATSAPP_WEBHOOK_TOKEN` is set — they
  expose whole conversations, not just the caller's own queue.
- Ruby API: `WhatsAppNotifier.list_chats(metadata:)` returns
  `[{ id:, name:, last_message_at: }]`;
  `WhatsAppNotifier.fetch_history(chat_id:, limit: 50, metadata:)` returns
  messages mapped exactly like `fetch_inbound` (including `from_me` / `to`
  and the media keys). Both raise on any non-2xx — 401 (never paired / not
  ready) included. The adapter mirrors the service's limit clamp so a wild
  host value can't balloon a request.
- The ejected service now ships `history.ts`.

### Media cap & on-demand re-download
WhatsApp's tap-to-download model: keep RECENT media per user, roll the rest
off, and re-pull any one item on demand when an operator opens its bubble.

- **Per-user 1GB rolling cap with LRU eviction** (`WHATSAPP_MEDIA_MAX_USER_BYTES`,
  default 1GB, NaN-safe). The cap is enforced AFTER each successful write:
  `enforceUserCap` deletes the user's OLDEST media (by `capturedAt`/mtime,
  same ordering as the TTL sweep) until they fit again. Because we
  download-then-evict, a user is **never skipped on disk grounds** — the old
  global `disk_full` skip (which starved real customer inbound media once the
  shared cap filled) is gone. `downloadPolicy` no longer returns `disk_full`;
  the per-MESSAGE size gate (16MB inline / `WHATSAPP_MEDIA_MAX_BYTES` for
  documents) stays, and `WHATSAPP_MEDIA_MAX_DISK_BYTES` remains only an
  absolute global backstop. Each user's cap is independent; eviction touches
  only that user's directory.
- **`POST /media/:userId/refetch`** `{ messageId, chatId }` re-downloads ONE
  message's media on demand. Token-gated and paired/ready-gated exactly like
  `/history`; `chatId` is normalized + `@c.us`-validated and `messageId`
  sanitized. The service resolves the message (`getMessageById`, falling back
  to a chat-history scan), runs it through the live download pipeline
  (per-message size cap + 30s timeout + cap-enforced store), and answers
  `{ success: true, messageId, mediaStatus: 'available', mediaMime,
  mediaFilename, mediaSize }`. After that the host fetches the bytes with the
  usual `GET /media`. Media gone upstream (deleted, too old) → `404
  { success: false, mediaStatus: 'unavailable', mediaError: 'gone' }`.
- Hosts can now **lazily re-download evicted or TTL-expired media**: when a
  `GET /media` 404s for a bubble the operator opened, call `refetch_media`
  first, then re-`GET`. Old media no longer needs to live on disk forever.
- Ruby API: `WhatsAppNotifier.refetch_media(message_id:, chat_id:, metadata:)`
  → `{ mime:, filename:, size:, status: }` on success, or `nil` when the media
  is gone upstream (404) — same nil-on-404 contract as `fetch_media`, so a host
  that gets `nil` can grey the bubble out. `respond_to?`-guarded through the
  provider/client/module chain like the other media helpers.

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
