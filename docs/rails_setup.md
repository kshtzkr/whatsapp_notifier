# Rails Setup

## Initializer

Create `config/initializers/whatsapp_notifier.rb`:

```ruby
WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
  config.bulk_base_delay_seconds = 1.2
  config.bulk_jitter_seconds = 0.4
  config.bulk_max_recipients = 300
  config.bulk_max_attempts = 3
end
```

Defaults already use a built-in adapter that talks to `http://127.0.0.1:3001`.

## Global usage

`WhatsAppNotifier` is available globally:

```ruby
WhatsAppNotifier.deliver(
  to: "+919999999999",
  body: "Payment received",
  metadata: { user_id: current_user.id }
)
```

## Mailer-like class usage

```ruby
class AlertsNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :web_automation
  template :payment_alert, "Hi {{name}}, payment {{amount}} received."

  def metadata
    { user_id: params[:user_id] }
  end
end

AlertsNotification.deliver_now(params: { name: "Riya", amount: "INR 1500" }, user_id: 42)
```

## Async behavior

`deliver_later` requires ActiveJob to be available.

```ruby
AlertsNotification.deliver_later(
  to: "+919999999999",
  params: { name: "Riya", amount: "INR 1500" }
)
```
