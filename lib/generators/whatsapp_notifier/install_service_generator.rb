require 'rails/generators' unless defined?(Rails::Generators::Base)

module WhatsAppNotifier
  module Generators
    class InstallServiceGenerator < Rails::Generators::Base
      source_root File.expand_path("../../whatsapp_notifier/services/web_automation", __dir__)

      # Eject an explicit file list, never `directory '.'`: source_root is the
      # LIVE gem service dir, so once the service has run it also contains
      # node_modules (hundreds of MB of platform-native binaries), .wwebjs /
      # .puppeteer session caches and *.test.ts — none of which belong in the
      # host app. The app rebuilds deps with `bun install`.
      SERVICE_FILES = %w[
        index.ts
        inbound.ts
        init_gate.ts
        metrics.ts
        sessions.ts
        package.json
        bun.lock
      ].freeze

      def copy_service_files
        SERVICE_FILES.each do |file|
          copy_file file, File.join("whatsapp_service", file)
        end
      end

      def add_to_gitignore
        entries = [
          "# WhatsApp Service",
          "/whatsapp_service/node_modules",
          "/whatsapp_service/.wwebjs_cache",
          "/whatsapp_service/.wwebjs_auth"
        ]
        content = File.exist?(".gitignore") ? File.read(".gitignore") : ""
        missing_entries = entries.reject { |entry| content.include?(entry) }
        return if missing_entries.empty?

        append_to_file ".gitignore", "\n#{missing_entries.join("\n")}\n"
      end

      def show_readme
        say "\nWhatsApp Service installed in /whatsapp_service", :green
        say "Make sure you have Bun installed: https://bun.sh", :yellow
        say "To start the service manually: cd whatsapp_service && bun index.ts", :yellow
      end
    end
  end
end
