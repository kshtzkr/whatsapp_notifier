require "whatsapp_notifier"

WhatsAppNotifier.configure do |config|
  config.provider = :official_api
  config.official_sender = lambda do |payload|
    puts "Sending to #{payload[:to]} => #{payload[:body]}"
    { success: true, message_id: "demo-001" }
  end
end

class WelcomeNotification < WhatsAppNotifier::Notification
  to "+919999999999"
  provider :official_api
  template :welcome, "Hi {{name}}, welcome to our platform."
end

WelcomeNotification.deliver_now(params: { name: "Asha" })
