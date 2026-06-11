require "thor"

module WhatsAppNotifier
  # Command-line entry point (`whatsapp_notifier doctor|service`). Lives in
  # lib (the bin stub just calls CLI.start) so it can be unit-tested.
  class CLI < Thor
    # Probed when PUPPETEER_EXECUTABLE_PATH is unset — the same Linux paths
    # Doctor accepts (Debian names the binary `chromium`, Ubuntu/snap-free
    # builds `chromium-browser`).
    CHROMIUM_AUTODETECT_PATHS = ["/usr/bin/chromium", "/usr/bin/chromium-browser"].freeze

    def self.exit_on_failure?
      true
    end

    desc "doctor", "Validate local setup and print exact fixes"
    def doctor
      ok = WhatsAppNotifier::Doctor.run
      raise Thor::Error, "Doctor checks failed. Apply fixes above and run again." unless ok

      puts "All checks passed."
    end

    desc "service", "Start the WhatsApp automation service (Bun)"
    option :port, type: :numeric,
                  desc: "Port to run the service on (default: #{WhatsAppNotifier::Doctor::DEFAULT_PORT})"
    def service
      service_path = WhatsAppNotifier.service_path
      puts "Starting WhatsApp Notifier Service from #{service_path}..."

      configure_port
      ENV["WHATSAPP_SESSION_DIR"] ||= WhatsAppNotifier::Doctor.session_dir
      ensure_bun!
      autodetect_chromium

      Dir.chdir(service_path) do
        install_dependencies(service_path)
        exec("bun index.ts")
      end
    end

    no_commands do
      # An explicit --port must beat a pre-set PORT env (`ENV["PORT"] ||=`
      # used to silently ignore the flag); without the flag the env still
      # wins over the built-in default.
      def configure_port
        if options[:port]
          ENV["PORT"] = options[:port].to_s
        else
          ENV["PORT"] ||= WhatsAppNotifier::Doctor::DEFAULT_PORT.to_s
        end
      end

      def ensure_bun!
        return if system("bun --version > /dev/null 2>&1")

        raise Thor::Error, "Bun is required. Install from https://bun.sh"
      end

      def autodetect_chromium
        return if ENV["PUPPETEER_EXECUTABLE_PATH"]

        found = CHROMIUM_AUTODETECT_PATHS.find { |path| File.exist?(path) }
        ENV["PUPPETEER_EXECUTABLE_PATH"] = found if found
      end

      def install_dependencies(service_path)
        return if File.exist?("node_modules")

        puts "Installing dependencies (bun install)..."
        return if system("bun install")

        raise Thor::Error, "Failed to install Bun dependencies in #{service_path}"
      end
    end
  end
end
