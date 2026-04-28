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

## Notes

- This gem uses WhatsApp Web automation. Use responsibly and follow WhatsApp policies.
- Keep Chromium available in your runtime (or set `PUPPETEER_EXECUTABLE_PATH`).

## License

MIT. See `LICENSE.txt`.
