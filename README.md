# WhatsAppNotifier

`whatsapp_notifier` is production-ready WhatsApp messaging for Rails.
Set it up in minutes with one install generator and one service command.

No official WhatsApp API setup, app review, or Meta webhook configuration is required.

## What You Get

- Bun-powered lightweight WhatsApp Web service (embedded in the gem)
- QR scanning and connection status APIs
- Single message and bulk message delivery APIs
- Mailer-like notification classes with `deliver_now` / `deliver_later`
- Multi-user session support via `metadata[:user_id]`

## Quick Start (60 seconds)

```bash
bundle add whatsapp_notifier
bin/rails g whatsapp_notifier:install
bin/dev
```

Then:

- open `/dashboard/whatsapp/qr`
- scan QR
- send a test message

If setup fails, run:

```bash
bundle exec whatsapp_notifier doctor
```

## Installation

```ruby
gem "whatsapp_notifier"
```

```bash
bundle install
bin/rails g whatsapp_notifier:install
```

## Scan QR and check status

```ruby
# Use current_user.id for multi-user apps; omit metadata for a default shared session.
qr_data_url = WhatsAppNotifier.scan_qr(metadata: { user_id: current_user.id })

status = WhatsAppNotifier.connection_status(metadata: { user_id: current_user.id })
# => { state: "...", authenticated: true/false, has_qr: true/false }
```

## Log out (disconnect + clear session)

Explicitly disconnects the user and wipes their saved WhatsApp session from the
service — including any downloaded inbound media and queued replies, which
belong to the old pairing — so the next connect starts fresh with a new QR.
Call this from a user-initiated "Log out WhatsApp" action — NOT from your
app's sign-out, which should leave the WhatsApp session intact for the next
login.

```ruby
WhatsAppNotifier.logout(metadata: { user_id: current_user.id })
# => { success: true }
```

The mounted engine also exposes `DELETE /whatsapp/logout` for the same effect.

## Send a message

```ruby
result = WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Booking confirmed",
  metadata: { user_id: current_user.id }
)

result.success?
```

## Notifications API

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
```

```ruby
LeadWhatsappNotification.with(lead: @lead, user: current_user).deliver_later
```

## Bulk Messaging

```ruby
messages = [
  { to: "+919999999991", body: "Hello A", metadata: { user_id: current_user.id } },
  { to: "+919999999992", body: "Hello B", metadata: { user_id: current_user.id } }
]

summary = WhatsAppNotifier.deliver_bulk(messages)
summary[:success]
```

## Generators

Install everything with one command:

```bash
rails generate whatsapp_notifier:install
```

If you want to eject Bun service files into your app:

```bash
rails generate whatsapp_notifier:install_service
```

This copies the service to `whatsapp_service/` and updates `.gitignore`.

## Service health probe

The Bun service exposes `GET /health` for load balancer / platform probes
(Azure, Kubernetes, uptime checks). It reads only in-memory state — it never
creates a WhatsApp client — so it is safe to poll every few seconds:

```json
{ "ok": true, "uptime_s": 4242, "sessions": 3, "ready": 2 }
```

`sessions` is the number of clients held in memory; `ready` is how many of
those have a fully hydrated WhatsApp Web store. Prometheus metrics live at
`GET /metrics`.

## Upgrading to 0.7.0

- **If your app monkey-patches `WhatsAppNotifier::WebAdapter#request`** (a
  common trick to bolt TLS onto the service URL): the shared JSON path now
  also carries `DELETE` (`delete_media`) and attaches `X-WA-Token` when
  `WHATSAPP_WEBHOOK_TOKEN` is set. A patch that only routes `POST`/`GET` or
  drops headers will break the new media calls. Prefer retiring the patch
  entirely — the adapter now honors `https://` service URLs natively on both
  the JSON control plane and the binary media path (`use_ssl` follows the URL
  scheme), so TLS no longer needs a patch.
- **Logout now wipes stored media**: `POST /logout` removes the user's
  downloaded inbound media along with the session dir and queued replies.
  Fetch (and ideally `delete_media`) anything you want to keep before logging
  a user out.

## Notes

- This gem uses WhatsApp Web automation. Use responsibly and follow WhatsApp policies.
- Keep Chromium available in your runtime (or set `PUPPETEER_EXECUTABLE_PATH`).
- Session profiles persist under `WHATSAPP_SESSION_DIR`. Careful: the
  `whatsapp_notifier service` CLI launcher defaults it to
  `./tmp/whatsapp_notifier/.wwebjs_auth` **relative to the current working
  directory** (only the bare Bun service falls back to `/whatsapp_data`).
  Production must set `WHATSAPP_SESSION_DIR` explicitly to a durable mount
  (e.g. `/whatsapp_data`) so logins survive restarts and redeploys; the
  service clears stale Chromium `SingletonLock` files on each launch so an
  unclean exit can't wedge it.
- Resilience knobs: `WHATSAPP_INIT_TIMEOUT_MS` (default 90000) recycles a client
  that never reaches QR/READY; `WHATSAPP_UNREADY_REAP_MS` (default 1800000)
  destroys non-ready clients idle that long (abandoned pairing screens; the
  cleanup sweep runs every 5 minutes, so reaping lands within ~5 minutes of
  the limit) —
  sessions that authenticated at least once keep their on-disk dir for
  reconnect, while a pairing that never authenticated has its credential-less
  dir removed too, so it cannot pass the paired-session gate later; set
  `WWEBJS_WEB_VERSION` (e.g. `2.3000.1023204887`,
  optionally `WWEBJS_WEB_VERSION_CACHE_URL`) to pin the WhatsApp Web build so a
  live web.whatsapp.com change can't silently break the client.

## License

MIT. See `LICENSE.txt`.
