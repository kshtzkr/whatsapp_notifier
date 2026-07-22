# Configuration reference

Every configuration option and every environment variable, with its type and
default read from the source. The gem is configured in Ruby; the bundled service
is configured through environment variables.

## Ruby configuration

Set these in `config/initializers/whatsapp_notifier.rb`:

```ruby
WhatsAppNotifier.configure do |config|
  config.bulk_max_recipients = 300
  # ...
end
```

`WhatsAppNotifier.configure` runs `validate!` after the block, so an invalid
value raises `WhatsAppNotifier::ConfigurationError` at boot.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `provider` | Symbol | `:web_automation` | Messaging backend. Only `:web_automation` is supported; any other value fails `validate!`. |
| `web_adapter` | object | `WhatsAppNotifier::WebAdapter.new` | HTTP client that talks to the service. Must respond to `send_message`, `fetch_qr_code`, and `connection_status`. |
| `web_session_path` | String | `"tmp/whatsapp_notifier/session.json"` | File where the gem stores per-user session pointers. |
| `bulk_base_delay_seconds` | Float | `1.0` | Base pause between consecutive bulk sends. |
| `bulk_jitter_seconds` | Float | `0.3` | Upper bound of random jitter added to each bulk pause. |
| `bulk_max_recipients` | Integer | `500` | Largest batch `deliver_bulk` accepts. Must be positive. |
| `bulk_max_attempts` | Integer | `3` | Attempts per message during bulk retries. Must be positive. |
| `bulk_retryable_error_codes` | Array\<Symbol\> | `%i[rate_limited network_error temporary_failure]` | Error codes that make a failed bulk send eligible for retry. |
| `logger` | Logger | `Logger.new($stdout)` | Logger used for warnings and diagnostics. |
| `web_automation_enabled` | Boolean | `true` | When false, the provider raises instead of sending. A kill switch. |
| `warn_on_risky_provider` | Boolean | `true` | Logs a one-time warning that web automation is unofficial. |
| `authenticate_with` | callable or nil | `nil` | Runs as a `before_action` inside the engine's controllers (for example `-> { authenticate_user! }`). |
| `current_user_id_resolver` | callable | resolves `current_user.id` | How the engine identifies the current user when talking to the service. |
| `parent_controller` | String | `"::ApplicationController"` | Class the engine's controllers inherit from, so they pick up your layout and filters. |
| `on_inbound_message_handler` | callable or nil | `nil` | Optional host hook invoked with each inbound message hash, for push-based integrations that would rather not poll. |

## Ruby-side environment variables

Read by the gem (the adapter, doctor, and CLI):

| Variable | Default | Description |
| --- | --- | --- |
| `WHATSAPP_NOTIFIER_SERVICE_URL` | `http://127.0.0.1:3001` | Base URL of the service. `https://` URLs are honored natively. |
| `WHATSAPP_SERVICE_URL` | (unset) | Legacy alias used only when `WHATSAPP_NOTIFIER_SERVICE_URL` is unset. |
| `WHATSAPP_WEBHOOK_TOKEN` | (unset) | When set, the adapter sends it as the `X-WA-Token` header on media, chats, and history requests, matching the service's gate. |
| `PUPPETEER_EXECUTABLE_PATH` | (unset) | Path to the Chromium/Chrome binary. Checked by `doctor` and the `service` command. |
| `WHATSAPP_SESSION_DIR` | `tmp/whatsapp_notifier/.wwebjs_auth` (via `doctor`/CLI) | Session directory the `doctor` check and the `service` launcher use. See the note below. |

## Service environment variables

Read by the bundled Bun service under
`lib/whatsapp_notifier/services/web_automation`:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3001` | Port the service listens on. The `service` command's `--port` flag sets this. |
| `WHATSAPP_SESSION_DIR` | `/whatsapp_data` | Base directory for per-user WhatsApp sessions. See the note below. |
| `PUPPETEER_EXECUTABLE_PATH` | (Puppeteer default) | Chromium/Chrome binary to launch. |
| `WHATSAPP_INIT_TIMEOUT_MS` | `90000` | Recycle a client that boots Chromium but never reaches QR or READY. |
| `WWEBJS_WEB_VERSION` | (library default) | Pin the WhatsApp Web build (for example `2.3000.1023204887`) so a live change on web.whatsapp.com cannot break the client. |
| `WWEBJS_WEB_VERSION_CACHE_URL` | wa-version template URL | Remote cache location for the pinned web version. |
| `WHATSAPP_WEBHOOK_URL` | (unset) | If set, the service POSTs each inbound message here instead of relying only on polling. |
| `WHATSAPP_WEBHOOK_TOKEN` | (unset) | Shared secret sent as `X-WA-Token` on webhook pushes. When set, it also gates `/media`, `/chats`, and `/history`. Set it in production. |
| `WHATSAPP_MAX_CONCURRENT_INITS` | `3` | Cap on concurrent Chromium launches, so a herd of cold starts cannot exhaust memory. |
| `WHATSAPP_UNREADY_REAP_MS` | `1800000` (30 min) | Destroy non-ready clients idle at least this long (abandoned pairing screens). Ready clients keep a 72h idle limit. |
| `WHATSAPP_BROWSER_TIMEOUT_MS` | `60000` | Puppeteer browser launch timeout. |
| `WHATSAPP_PROTOCOL_TIMEOUT_MS` | `120000` | Puppeteer protocol timeout. |
| `WHATSAPP_MEDIA_TTL_MS` | `172800000` (48h) | Lifetime of downloaded inbound media before the sweep evicts it. |
| `WHATSAPP_MEDIA_MAX_BYTES` | `26214400` (25MB) | Per-document download cap. Inline images and voice notes cap at WhatsApp's 16MB ceiling. |
| `WHATSAPP_MEDIA_MAX_USER_BYTES` | `1073741824` (1GB) | Per-user rolling media cap with LRU eviction. The cap that shapes disk use. |
| `WHATSAPP_MEDIA_MAX_DISK_BYTES` | `5368709120` (5GB) | Absolute global backstop for total media on disk. |

Malformed numeric values (for example `"50GB"`) fall back to the default rather
than parsing to `NaN` and disabling a limit.

### Note on the session directory

`WHATSAPP_SESSION_DIR` has two different defaults depending on how the service
starts:

- Run directly (`bun index.ts`), it defaults to `/whatsapp_data`.
- Run through `bundle exec whatsapp_notifier service`, the CLI sets it, if unset,
  to `tmp/whatsapp_notifier/.wwebjs_auth` relative to the current working
  directory.

In production, set `WHATSAPP_SESSION_DIR` explicitly to a durable mount so logins
survive restarts and redeploys.
