require "whatsapp_notifier"

WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
end

class WelcomeNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :web_automation
  template :welcome, "Hi {{name}}, welcome to our platform."
end

WelcomeNotification.deliver_now(params: { name: "Asha" }, metadata: { user_id: "demo-user" })
