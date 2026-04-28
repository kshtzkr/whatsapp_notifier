require "rails/generators"
require "whatsapp_notifier/doctor"

module WhatsAppNotifier
  module Generators
    class InstallGenerator < Rails::Generators::Base
      source_root File.expand_path("templates", __dir__)

      def create_initializer
        return if File.exist?("config/initializers/whatsapp_notifier.rb")

        template "whatsapp_notifier.rb", "config/initializers/whatsapp_notifier.rb"
      end

      def ensure_procfile_entry
        procfile = "Procfile.dev"
        line = "whatsapp: bundle exec whatsapp_notifier service"

        unless File.exist?(procfile)
          create_file(procfile, "#{line}\n")
          return
        end

        content = File.read(procfile)
        return if content.lines.any? { |existing| existing.strip == line }

        append_to_file(procfile, "\n#{line}\n")
      end

      def ensure_gitignore_entries
        entries = [
          "# WhatsApp Notifier",
          "/tmp/whatsapp_notifier",
          "/whatsapp_service/node_modules",
          "/whatsapp_service/.wwebjs_cache",
          "/whatsapp_service/.wwebjs_auth"
        ]

        content = File.exist?(".gitignore") ? File.read(".gitignore") : ""
        missing = entries.reject { |entry| content.include?(entry) }
        return if missing.empty?

        append_to_file(".gitignore", "\n#{missing.join("\n")}\n")
      end

      def run_doctor
        say("\nRunning setup doctor...", :yellow)
        ok = WhatsAppNotifier::Doctor.run(io: $stdout, app_root: destination_root)
        return if ok

        raise Thor::Error, "Setup checks failed. Fix items above, then run `bundle exec whatsapp_notifier doctor`."
      end

      def next_steps
        say("\nSetup complete.", :green)
        say("Run `bin/dev`, open `/dashboard/whatsapp/qr`, then send a test message.", :green)
      end
    end
  end
end
