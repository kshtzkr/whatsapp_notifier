WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true
end

ENV["WHATSAPP_NOTIFIER_SERVICE_URL"] ||= "http://127.0.0.1:3001"
