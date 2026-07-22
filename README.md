# whatsapp_notifier

[![Gem Version](https://img.shields.io/gem/v/whatsapp_notifier.svg)](https://rubygems.org/gems/whatsapp_notifier)
[![CI](https://github.com/kshtzkr/whatsapp_notifier/actions/workflows/ci.yml/badge.svg)](https://github.com/kshtzkr/whatsapp_notifier/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.txt)
[![Ruby](https://img.shields.io/badge/ruby-%3E%3D%202.6-CC342D.svg)](whatsapp_notifier.gemspec)

Add WhatsApp messaging to a Rails app with one install generator and one service
command.

The gem gives you a small Ruby API (`WhatsAppNotifier.deliver`, mailer-style
notification classes, and paced bulk delivery) plus a bundled Bun service that
holds the WhatsApp Web session. No Meta developer account, app review, or webhook
configuration is required, because messages go through a linked WhatsApp Web
session rather than the official Business API.

That trade-off matters: this drives an unofficial WhatsApp Web automation
session, so use it for consent-based, low-volume messaging and read
[docs/bulk_messaging_policy.md](docs/bulk_messaging_policy.md) before you send at
scale. See [How it works](#how-it-works) for the service boundary.

## Table of contents

- [Requirements](#requirements)
- [How it works](#how-it-works)
- [Installation](#installation)
- [Quick start](#quick-start)
- [Connecting a number](#connecting-a-number)
- [Sending a message](#sending-a-message)
- [Notification classes](#notification-classes)
- [Bulk delivery](#bulk-delivery)
- [Receiving messages and media](#receiving-messages-and-media)
- [Command line](#command-line)
- [Mounted engine routes](#mounted-engine-routes)
- [Configuration](#configuration)
- [Logging out](#logging-out)
- [Testing](#testing)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [Versioning](#versioning)
- [License](#license)

## Requirements

- Ruby 2.6 or newer (the gemspec sets `required_ruby_version >= 2.6.0`; CI runs
  on 3.2, 3.3, and 3.4).
- Runtime gem dependencies: `logger >= 1.5` and `thor >= 1.0`.
- Rails for the mountable engine and the install generators. The engine
  registers a Zeitwerk inflection, so it needs Rails 6 or newer. The plain Ruby
  API (`WhatsAppNotifier.deliver`, notification classes, bulk delivery) works
  without Rails.
- [Bun](https://bun.sh) to run the bundled WhatsApp Web service.
- Chromium or Chrome reachable by the service. Puppeteer drives it; set
  `PUPPETEER_EXECUTABLE_PATH` if the binary is not on a standard path.

## How it works

Two processes cooperate:

1. Your Ruby or Rails app, using this gem. `WhatsAppNotifier::WebAdapter` speaks
   JSON over HTTP to the service (default `http://127.0.0.1:3001`).
2. The bundled service under `lib/whatsapp_notifier/services/web_automation`. It
   runs on Bun (Hono + `whatsapp-web.js`) and drives a headless Chromium against
   `web.whatsapp.com`. It keeps one WhatsApp Web client per `user_id` and
   persists each session on disk so restarts reconnect without a new QR.

Nothing here touches the official WhatsApp Business API. The service pairs like
WhatsApp Web on a laptop, which is why setup needs no Meta account, and why the
bulk-delivery guardrails exist. Point the gem at a remote service with
`WHATSAPP_NOTIFIER_SERVICE_URL` (or `WHATSAPP_SERVICE_URL`); `https://` URLs are
honored natively.

## Installation

Add the gem:

```ruby
# Gemfile
gem "whatsapp_notifier"
```

```bash
bundle install
```

Then run the install generator:

```bash
bin/rails g whatsapp_notifier:install
```

The generator:

- writes `config/initializers/whatsapp_notifier.rb`,
- mounts the engine with `mount WhatsAppNotifier::Engine, at: "/whatsapp"`,
- adds `whatsapp: bundle exec whatsapp_notifier service` to `Procfile.dev`,
- adds session and service paths to `.gitignore`,
- runs `whatsapp_notifier doctor` to check your setup.

The gem ships no migrations, so there is no `db:migrate` step.

Start the service alongside your app. With the `Procfile.dev` entry above,
`bin/dev` runs it; on its own:

```bash
bundle exec whatsapp_notifier service
```

The first run installs the service's dependencies with `bun install`, then
launches it on port 3001.

## Quick start

```bash
bundle add whatsapp_notifier
bin/rails g whatsapp_notifier:install
bin/dev
```

With the service running, connect a number (see below), then send:

```ruby
result = WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Booking confirmed",
  metadata: { user_id: current_user.id }
)

result.success? # => true
```

If setup fails, run the diagnostics:

```bash
bundle exec whatsapp_notifier doctor
```

## Connecting a number

Each linked number is a session keyed by `metadata[:user_id]`. Omit the key to
use a single shared `default` session; pass `current_user.id` (or any stable id)
for per-user sessions.

Fetch the current QR and render it. The service returns a `data:` PNG URL, or
`nil` while the client is still booting:

```ruby
qr_data_url = WhatsAppNotifier.scan_qr(metadata: { user_id: current_user.id })
# => "data:image/png;base64,..." or nil
```

Show that image, scan it from the phone (WhatsApp, Linked devices, Link a
device), then poll the connection status until it reports authenticated:

```ruby
status = WhatsAppNotifier.connection_status(metadata: { user_id: current_user.id })
# => { state: "AUTHENTICATED", authenticated: true, has_qr: false }
```

The QR rotates every ~20 seconds, so re-fetch it while `has_qr` is true. Once a
session authenticates it persists on the service, so later sends reconnect
without a new scan.

The mounted engine exposes the same two steps as JSON endpoints
(`GET /whatsapp/qr` and `GET /whatsapp/status`) if you prefer to build the
pairing screen in your front end.

## Sending a message

```ruby
result = WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Payment received",
  metadata: { user_id: current_user.id }
)
```

`deliver` returns a `WhatsAppNotifier::Result`:

| Method | Meaning |
| --- | --- |
| `success?` / `failure?` | delivery outcome |
| `message_id` | WhatsApp message id from the service (a local fallback id on older services) |
| `error_code` | symbol such as `:delivery_exception` on failure |
| `error_message` | human-readable failure reason |
| `wait_seconds` | provider-requested backoff, honored by bulk delivery |
| `metadata` | provider metadata hash |

To attach a file, pass its URL as `metadata[:media_url]`:

```ruby
WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Here is your invoice",
  metadata: { user_id: current_user.id, media_url: invoice_url }
)
```

The engine also exposes `POST /whatsapp/send` with `to` (or `phone`), `message`,
and optional `media_url`.

## Notification classes

Model messages as mailer-style classes. Define `#message` (and `#to`), or use a
class-level template.

Method style:

```ruby
class LeadWhatsappNotification < WhatsAppNotifier::Notification
  def to
    params[:lead].phone_number
  end

  def message
    "Hi #{params[:lead].name}, we are working on your itinerary."
  end

  def metadata
    { user_id: params[:user].id }
  end
end

LeadWhatsappNotification.with(lead: @lead, user: current_user).deliver_later
```

Template style. Template variables come from the nested `params:` hash and fill
`{{placeholders}}`:

```ruby
class PaymentAlertNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :web_automation
  template :payment_alert, "Hi {{name}}, payment {{amount}} received."

  def metadata
    { user_id: params[:user_id] }
  end
end

PaymentAlertNotification.deliver_now(
  params: { name: "Riya", amount: "INR 1500" },
  user_id: 42
)
```

`deliver_later` runs through ActiveJob (queue `:default`) when it is available in
the host app. Without ActiveJob loaded it falls back to running inline, so the
call still delivers.

## Bulk delivery

```ruby
messages = [
  { to: "+919999999991", body: "Hello A", metadata: { user_id: current_user.id } },
  { to: "+919999999992", body: "Hello B", metadata: { user_id: current_user.id } }
]

summary = WhatsAppNotifier.deliver_bulk(messages)
# => { total: 2, success: 2, failed: 0, results: [#<Result>, #<Result>] }
```

Each message accepts `to`, `body`, `metadata`, and an optional
`idempotency_key`. The dispatcher:

- paces sends with `bulk_base_delay_seconds` plus up to `bulk_jitter_seconds` of
  random jitter,
- rejects a batch larger than `bulk_max_recipients`,
- retries a failed send up to `bulk_max_attempts` times, but only when its
  `error_code` is in `bulk_retryable_error_codes`,
- sleeps for `wait_seconds` when a result asks for backoff,
- skips a repeated `idempotency_key` within the same run.

See [docs/bulk_messaging_policy.md](docs/bulk_messaging_policy.md) for the
guardrails and recommended limits.

## Receiving messages and media

The service captures both sides of each 1:1 conversation and buffers inbound
messages per user. Drain them (at-least-once; dedupe on `message_id`):

```ruby
WhatsAppNotifier.fetch_inbound(metadata: { user_id: current_user.id })
# => [{ from:, body:, message_id:, timestamp:, type:, ... }]
```

Related helpers, each keyed by the same `metadata`:

- `WhatsAppNotifier.fetch_media(message_id:, metadata:)` returns
  `{ body:, mime:, filename:, size: }`, or `nil` when the service has no copy.
- `WhatsAppNotifier.refetch_media(message_id:, chat_id:, metadata:)` re-downloads
  one message's media on demand.
- `WhatsAppNotifier.delete_media(message_id:, metadata:)` drops the service's
  copy after you have stored the bytes.
- `WhatsAppNotifier.list_chats(metadata:)` lists the paired number's 1:1 chats.
- `WhatsAppNotifier.fetch_history(chat_id:, limit: 50, metadata:)` replays one
  chat's recent history.

The engine also exposes `GET /whatsapp/inbound` for host apps that would rather
pull through Rails. The `CHANGELOG.md` records when each capability landed and
the wire-compatibility rules between gem and service versions.

## Command line

The `whatsapp_notifier` executable (Thor) has two commands.

```bash
# Start the bundled WhatsApp Web service (Bun). --port overrides the default 3001.
bundle exec whatsapp_notifier service [--port 3001]

# Validate local setup and print exact fixes.
bundle exec whatsapp_notifier doctor
```

`doctor` checks that Bun is installed, that a Chromium-compatible browser is
found (or `PUPPETEER_EXECUTABLE_PATH` is set), that the session directory is
writable, and that the service URL is well-formed. It exits non-zero and prints
a fix for each failed check.

`service` sets `PORT`, defaults `WHATSAPP_SESSION_DIR` to a writable path under
the app, autodetects Chromium, installs the service's dependencies on first run,
then execs `bun index.ts`.

## Mounted engine routes

`whatsapp_notifier:install` mounts the engine at `/whatsapp`. Every action
returns JSON.

| Method | Path | Action | Purpose |
| --- | --- | --- | --- |
| GET | `/whatsapp/status` | `sessions#show` | connection state for the current user |
| GET | `/whatsapp/qr` | `sessions#qr` | latest QR (`nil` while initializing) |
| DELETE | `/whatsapp/logout` | `sessions#destroy` | disconnect and clear the session |
| POST | `/whatsapp/send` | `messages#create` | send one message |
| GET | `/whatsapp/inbound` | `messages#inbound` | drain pending inbound messages |

The engine resolves the current user through
`config.current_user_id_resolver` and can run an auth hook through
`config.authenticate_with` (see [Configuration](#configuration)). To eject the
Bun service source into your app instead of running it from the gem:

```bash
rails generate whatsapp_notifier:install_service
```

This copies the service files to `whatsapp_service/` and updates `.gitignore`.

## Configuration

Configure the gem in `config/initializers/whatsapp_notifier.rb`:

```ruby
WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
  config.bulk_base_delay_seconds = 1.2
  config.bulk_jitter_seconds = 0.4
  config.bulk_max_recipients = 300
end
```

The most common options and their defaults:

| Option | Default | Purpose |
| --- | --- | --- |
| `provider` | `:web_automation` | messaging backend; only `:web_automation` is supported |
| `web_session_path` | `"tmp/whatsapp_notifier/session.json"` | where the gem stores session pointers |
| `bulk_base_delay_seconds` | `1.0` | base pause between bulk sends |
| `bulk_jitter_seconds` | `0.3` | random jitter added to each bulk pause |
| `bulk_max_recipients` | `500` | largest batch `deliver_bulk` accepts |
| `bulk_max_attempts` | `3` | attempts per message in bulk retries |
| `authenticate_with` | `nil` | callable run as a `before_action` in the engine |
| `current_user_id_resolver` | resolves `current_user.id` | how the engine identifies the user |

The full reference (every configuration option and every service environment
variable, with types and defaults) is in
[docs/CONFIGURATION.md](docs/CONFIGURATION.md). For a longer Rails walk-through,
see [docs/rails_setup.md](docs/rails_setup.md).

## Logging out

`logout` disconnects the user and wipes their saved WhatsApp session on the
service, including downloaded inbound media and queued replies, so the next
connect starts fresh with a new QR:

```ruby
WhatsAppNotifier.logout(metadata: { user_id: current_user.id })
# => { success: true }
```

Call this from a user-initiated "Log out WhatsApp" action, not from your app's
sign-out, which should leave the session intact for the next login. The engine
exposes `DELETE /whatsapp/logout` for the same effect.

## Testing

Run the Ruby suite (SimpleCov enforces 100% line coverage):

```bash
bundle exec rspec
```

The bundled service has its own tests:

```bash
cd lib/whatsapp_notifier/services/web_automation
bun install
bun test
```

CI runs both jobs (`.github/workflows/ci.yml`): RSpec on Ruby 3.2–3.4 and the
Bun service tests.

## Development

```bash
git clone https://github.com/kshtzkr/whatsapp_notifier.git
cd whatsapp_notifier
bundle install
bundle exec rspec
```

The gemspec requires MFA for RubyGems pushes (`rubygems_mfa_required`).

## Contributing

Bug reports and pull requests are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup, the branch and PR flow, and the
commit style. By participating you agree to the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md) for how.

## Versioning

This project follows [Semantic Versioning](https://semver.org). Notable changes
are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

Released under the MIT License. See [LICENSE.txt](LICENSE.txt).
