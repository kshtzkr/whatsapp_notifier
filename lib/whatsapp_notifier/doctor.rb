require "fileutils"

module WhatsAppNotifier
  module Doctor
    module_function

    DEFAULT_PORT = 3001

    def run(io: $stdout, env: ENV, app_root: Dir.pwd)
      checks = [
        check_bun,
        check_chromium(env: env),
        check_session_dir(env: env, app_root: app_root),
        check_service_url(env: env)
      ]

      checks.each do |check|
        icon = check[:ok] ? "PASS" : "FAIL"
        io.puts("#{icon}: #{check[:name]}")
        io.puts("  #{check[:message]}")
      end

      failed = checks.reject { |check| check[:ok] }
      return true if failed.empty?

      io.puts("")
      io.puts("Quick fixes:")
      failed.each { |check| io.puts("- #{check[:fix]}") if check[:fix] }
      false
    end

    def session_dir(env: ENV, app_root: Dir.pwd)
      env["WHATSAPP_SESSION_DIR"] || File.expand_path("tmp/whatsapp_notifier/.wwebjs_auth", app_root)
    end

    def default_service_url
      "http://127.0.0.1:#{DEFAULT_PORT}"
    end

    def check_bun
      if system("bun --version > /dev/null 2>&1")
        { ok: true, name: "Bun installed", message: "bun is available in PATH." }
      else
        {
          ok: false,
          name: "Bun installed",
          message: "bun is missing.",
          fix: "Install Bun from https://bun.sh then rerun `bundle exec whatsapp_notifier doctor`."
        }
      end
    end

    def check_chromium(env: ENV)
      executable = env["PUPPETEER_EXECUTABLE_PATH"]
      if executable && File.executable?(executable)
        return { ok: true, name: "Chromium path", message: "Using PUPPETEER_EXECUTABLE_PATH=#{executable}." }
      end

      common_paths = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      found = common_paths.find { |path| File.executable?(path) }

      if found
        { ok: true, name: "Chromium path", message: "Detected Chromium-compatible executable at #{found}." }
      else
        {
          ok: false,
          name: "Chromium path",
          message: "No Chromium executable found.",
          fix: "Install Chromium/Chrome or set PUPPETEER_EXECUTABLE_PATH=/path/to/chrome."
        }
      end
    end

    def check_session_dir(env: ENV, app_root: Dir.pwd)
      dir = session_dir(env: env, app_root: app_root)
      FileUtils.mkdir_p(dir)
      File.write(File.join(dir, ".write_test"), "ok")
      File.delete(File.join(dir, ".write_test"))
      { ok: true, name: "Session directory", message: "Writable directory at #{dir}." }
    rescue StandardError => e
      {
        ok: false,
        name: "Session directory",
        message: "Cannot write to #{dir}: #{e.message}",
        fix: "Ensure the directory is writable or set WHATSAPP_SESSION_DIR to a writable path."
      }
    end

    def check_service_url(env: ENV)
      service_url = env["WHATSAPP_NOTIFIER_SERVICE_URL"] || env["WHATSAPP_SERVICE_URL"] || default_service_url
      if service_url.match?(%r{\Ahttps?://})
        { ok: true, name: "Service URL", message: "Using #{service_url}." }
      else
        {
          ok: false,
          name: "Service URL",
          message: "Invalid URL: #{service_url.inspect}",
          fix: "Set WHATSAPP_NOTIFIER_SERVICE_URL to something like #{default_service_url}."
        }
      end
    end
  end
end
