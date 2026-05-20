require "rails/engine"

module WhatsAppNotifier
  class Engine < ::Rails::Engine
    isolate_namespace WhatsAppNotifier

    config.whatsapp_notifier = {}

    # The module name is WhatsAppNotifier (CapApp), but Zeitwerk's default
    # inflector camelizes "whatsapp_notifier" -> "WhatsappNotifier" (single
    # N). Without this override, controllers under app/controllers/
    # whatsapp_notifier/ are indexed under the wrong constant and the
    # host app gets "uninitialized constant WhatsAppNotifier::*" on every
    # request to a mounted engine route. Inflect once for both autoloaders.
    initializer "whatsapp_notifier.inflector", before: :set_autoload_paths do
      mappings = { "whatsapp_notifier" => "WhatsAppNotifier" }
      [Rails.autoloaders.main, Rails.autoloaders.once].each do |loader|
        next unless loader.respond_to?(:inflector)
        loader.inflector.inflect(mappings)
      end
    end

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
