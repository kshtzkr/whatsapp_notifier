# Rails Setup

## Initializer

Create `config/initializers/whatsapp_notifier.rb`:

```ruby
WhatsAppNotifier.configure do |config|
  config.provider = :official_api
  config.official_sender = lambda do |payload|
    # Call official WhatsApp API client
    # payload[:to], payload[:body], payload[:metadata]
    { success: true, message_id: "id-1" }
  end

  config.bulk_base_delay_seconds = 1.2
  config.bulk_jitter_seconds = 0.4
  config.bulk_max_recipients = 300
  config.bulk_max_attempts = 3
end
```

## Global usage

`WhatsAppNotifier` is available globally:

```ruby
WhatsAppNotifier.deliver(to: "+919999999999", body: "Payment received")
```

## Mailer-like class usage

```ruby
class AlertsNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :official_api
  template :payment_alert, "Hi {{name}}, payment {{amount}} received."
end

AlertsNotification.deliver_now(params: { name: "Riya", amount: "INR 1500" })
```

## Async behavior

`deliver_later` requires ActiveJob to be available.

```ruby
AlertsNotification.deliver_later(
  to: "+919999999999",
  params: { name: "Riya", amount: "INR 1500" }
)
```
