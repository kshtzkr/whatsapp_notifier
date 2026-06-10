require "spec_helper"
require "whatsapp_notifier/cli"
require "fileutils"

RSpec.describe WhatsAppNotifier::CLI do
  ENV_KEYS = %w[PORT WHATSAPP_SESSION_DIR PUPPETEER_EXECUTABLE_PATH].freeze

  around do |example|
    saved = ENV_KEYS.to_h { |key| [key, ENV[key]] }
    ENV_KEYS.each { |key| ENV.delete(key) }
    example.run
  ensure
    saved.each { |key, value| value.nil? ? ENV.delete(key) : ENV[key] = value }
  end

  describe "doctor" do
    it "prints success when all checks pass" do
      allow(WhatsAppNotifier::Doctor).to receive(:run).and_return(true)

      expect { described_class.start(["doctor"]) }.to output(/All checks passed/).to_stdout
    end

    it "fails loudly when checks fail" do
      allow(WhatsAppNotifier::Doctor).to receive(:run).and_return(false)

      expect do
        expect { described_class.start(["doctor"]) }.to raise_error(SystemExit)
      end.to output(/Doctor checks failed/).to_stderr
    end
  end

  describe "service" do
    let(:service_dir) do
      dir = Dir.mktmpdir
      FileUtils.mkdir_p(File.join(dir, "node_modules"))
      dir
    end

    after { FileUtils.remove_entry(service_dir) }

    def run_service(argv = [])
      allow(WhatsAppNotifier).to receive(:service_path).and_return(service_dir)
      allow_any_instance_of(described_class).to receive(:system).and_return(true)
      allow_any_instance_of(described_class).to receive(:exec)

      expect do
        described_class.start(["service", *argv])
      end.to output(/Starting WhatsApp Notifier Service/).to_stdout
    end

    it "lets an explicit --port flag beat a pre-set PORT env" do
      ENV["PORT"] = "9999"

      run_service(["--port", "4100"])

      expect(ENV["PORT"]).to eq("4100")
    end

    it "keeps a pre-set PORT env when no flag is given" do
      ENV["PORT"] = "9999"

      run_service

      expect(ENV["PORT"]).to eq("9999")
    end

    it "falls back to the default port and session dir" do
      run_service

      expect(ENV["PORT"]).to eq(WhatsAppNotifier::Doctor::DEFAULT_PORT.to_s)
      expect(ENV["WHATSAPP_SESSION_DIR"]).to eq(WhatsAppNotifier::Doctor.session_dir)
    end
  end

  describe "#ensure_bun!" do
    it "raises when bun is not installed" do
      cli = described_class.new
      allow(cli).to receive(:system).and_return(false)

      expect { cli.send(:ensure_bun!) }.to raise_error(Thor::Error, /Bun is required/)
    end
  end

  describe "#autodetect_chromium" do
    it "respects an explicit PUPPETEER_EXECUTABLE_PATH" do
      ENV["PUPPETEER_EXECUTABLE_PATH"] = "/custom/chrome"

      described_class.new.send(:autodetect_chromium)

      expect(ENV["PUPPETEER_EXECUTABLE_PATH"]).to eq("/custom/chrome")
    end

    it "detects chromium-browser like Doctor does" do
      allow(File).to receive(:exist?).and_return(false)
      allow(File).to receive(:exist?).with("/usr/bin/chromium-browser").and_return(true)

      described_class.new.send(:autodetect_chromium)

      expect(ENV["PUPPETEER_EXECUTABLE_PATH"]).to eq("/usr/bin/chromium-browser")
    end

    it "leaves the env unset when no Chromium is found" do
      allow(File).to receive(:exist?).and_return(false)

      described_class.new.send(:autodetect_chromium)

      expect(ENV["PUPPETEER_EXECUTABLE_PATH"]).to be_nil
    end
  end

  describe "#install_dependencies" do
    it "runs bun install when node_modules is missing" do
      cli = described_class.new
      allow(cli).to receive(:system).with("bun install").and_return(true)

      Dir.mktmpdir do |dir|
        Dir.chdir(dir) do
          expect { cli.send(:install_dependencies, dir) }.to output(/Installing dependencies/).to_stdout
        end
      end
    end

    it "raises when bun install fails" do
      cli = described_class.new
      allow(cli).to receive(:system).with("bun install").and_return(false)

      Dir.mktmpdir do |dir|
        Dir.chdir(dir) do
          expect do
            expect { cli.send(:install_dependencies, dir) }.to raise_error(Thor::Error, /Failed to install/)
          end.to output(/Installing dependencies/).to_stdout
        end
      end
    end
  end
end
