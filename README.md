# WhatsAppNotifier

`whatsapp_notifier` is a Rails-friendly gem for WhatsApp Web automation.
It is intentionally simple: run the bundled Bun service, scan a QR code, and send messages.

No official WhatsApp API setup, app review, or Meta webhook configuration is required.

## What You Get

- Bun-powered lightweight WhatsApp Web service (embedded in the gem)
- QR scanning and connection status APIs
- Single message and bulk message delivery APIs
- Mailer-like notification classes with `deliver_now` / `deliver_later`
- Multi-user session support via `metadata[:user_id]`

## Installation

```ruby
gem "whatsapp_notifier", github: "kshtzkr/whatsapp_notifier"
```

```bash
bundle install
```

## Quick Start

### 1) Start the bundled Bun service

```bash
bundle exec whatsapp_notifier service --port 3001
```

That command:
- validates Bun is installed
- installs service dependencies (first run only)
- starts the service

### 2) Optional initializer

Defaults already point to the local service (`http://127.0.0.1:3001`), so this is optional:

```ruby
# config/initializers/whatsapp_notifier.rb
WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
  # Optional override:
  # ENV["WHATSAPP_NOTIFIER_SERVICE_URL"] = "http://127.0.0.1:3001"
end
```

### 3) Scan QR and check status

```ruby
# Use current_user.id for multi-user apps; omit metadata for a default shared session.
qr_data_url = WhatsAppNotifier.scan_qr(metadata: { user_id: current_user.id })

status = WhatsAppNotifier.connection_status(metadata: { user_id: current_user.id })
# => { state: "...", authenticated: true/false, has_qr: true/false }
```

### 4) Send a message

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

## Rails Generator (Service Eject)

If you want full control over the Bun service code in your app:

```bash
rails generate whatsapp_notifier:install_service
```

This copies the service to `whatsapp_service/` and updates `.gitignore`.

## Notes

- This gem uses WhatsApp Web automation. Use responsibly and follow WhatsApp policies.
- Keep Chromium available in your runtime (or set `PUPPETEER_EXECUTABLE_PATH`).

## License

MIT License.
