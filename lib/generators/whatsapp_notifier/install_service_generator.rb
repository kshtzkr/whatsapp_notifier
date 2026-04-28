require 'rails/generators'

module WhatsAppNotifier
  module Generators
    class InstallServiceGenerator < Rails::Generators::Base
      source_root File.expand_path("../../whatsapp_notifier/services/web_automation", __dir__)

      def copy_service_files
        directory '.', 'whatsapp_service'
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
