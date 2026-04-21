module WhatsAppNotifier
  class Railtie < ::Rails::Railtie
    config.whatsapp_notifier = {}

    initializer "whatsapp_notifier.configure" do |app|
      WhatsAppNotifier.configure do |config|
        app.config.whatsapp_notifier.each do |key, value|
          setter = "#{key}="
          config.public_send(setter, value) if config.respond_to?(setter)
        end
      end
    end
  end
end
