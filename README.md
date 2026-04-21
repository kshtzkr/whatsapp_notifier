# WhatsAppNotifier

`whatsapp_notifier` is a plug-and-play Ruby gem for Rails-style WhatsApp notifications with:

- official provider support (recommended default)
- optional WhatsApp Web automation (QR based, experimental)
- guarded bulk delivery with pacing, retries, and wait-time handling
- mailer-like notification classes (`deliver_now` and `deliver_later`)

## Installation

Add this line to your app's Gemfile:

```ruby
gem "whatsapp_notifier"
```

Then run:

```bash
bundle install
```

## Quick setup

```ruby
# config/initializers/whatsapp_notifier.rb
WhatsAppNotifier.configure do |config|
  config.provider = :official_api
  config.official_sender = lambda do |payload|
    # Integrate official API call here.
    # Return keys: success, message_id, error_code, error_message, wait_seconds, metadata
    { success: true, message_id: "msg-#{Time.now.to_i}" }
  end
end
```

## Send one message

```ruby
WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Booking confirmed"
)
```

## Bulk delivery

```ruby
messages = [
  { to: "+919999999990", body: "Hello A", idempotency_key: "bulk-1" },
  { to: "+919999999991", body: "Hello B", idempotency_key: "bulk-2" }
]

result = WhatsAppNotifier.deliver_bulk(messages)
result[:success] # => number of successful sends
```

## Mailer-like notifications

```ruby
class BookingNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :official_api
  template :booking_confirmed, "Hi {{name}}, booking {{booking_id}} is confirmed."
end

BookingNotification.deliver_now(
  params: { name: "Aman", booking_id: "BK-123" }
)
```

## QR scan (web automation provider)

```ruby
WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
  config.web_adapter = YourAdapter.new
end

qr_text = WhatsAppNotifier.scan_qr
```

## Compliance and safety

- Keep `:official_api` as the default provider for policy-safe production use.
- `:web_automation` is experimental and may violate WhatsApp terms depending on usage.
- Bulk sending is rate-limited and can pause automatically on provider wait-time signals.

More details:
- [Rails setup](docs/rails_setup.md)
- [Bulk messaging policy guardrails](docs/bulk_messaging_policy.md)
