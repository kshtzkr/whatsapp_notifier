require "spec_helper"
require "tmpdir"

RSpec.describe WhatsAppNotifier::Doctor do
  describe ".session_dir" do
    it "uses provided env path when set" do
      env = { "WHATSAPP_SESSION_DIR" => "/tmp/custom_sessions" }
      expect(described_class.session_dir(env: env, app_root: "/app")).to eq("/tmp/custom_sessions")
    end
  end

  describe ".run" do
    it "returns true when dependencies and paths are valid" do
      Dir.mktmpdir do |tmpdir|
        env = {
          "PUPPETEER_EXECUTABLE_PATH" => "/bin/sh",
          "WHATSAPP_SESSION_DIR" => File.join(tmpdir, "sessions"),
          "WHATSAPP_NOTIFIER_SERVICE_URL" => "http://127.0.0.1:3001"
        }
        io = StringIO.new

        allow(described_class).to receive(:system).with("bun --version > /dev/null 2>&1").and_return(true)

        expect(described_class.run(io: io, env: env, app_root: tmpdir)).to be(true)
        expect(io.string).to include("PASS: Bun installed")
      end
    end

    it "returns false and prints fixes when checks fail" do
      Dir.mktmpdir do |tmpdir|
        env = {
          "PUPPETEER_EXECUTABLE_PATH" => "/missing/chrome",
          "WHATSAPP_NOTIFIER_SERVICE_URL" => "not-a-url"
        }
        io = StringIO.new

        allow(described_class).to receive(:system).with("bun --version > /dev/null 2>&1").and_return(false)
        allow(File).to receive(:executable?).and_return(false)
        allow(FileUtils).to receive(:mkdir_p)
        allow(File).to receive(:write).and_raise(Errno::EACCES)

        expect(described_class.run(io: io, env: env, app_root: tmpdir)).to be(false)
        expect(io.string).to include("Quick fixes:")
      end
    end
  end

  describe ".check_chromium" do
    it "returns success when chromium is found in common paths" do
      env = {}
      allow(File).to receive(:executable?).and_return(false)
      allow(File).to receive(:executable?).with("/usr/bin/chromium").and_return(true)

      result = described_class.check_chromium(env: env)

      expect(result[:ok]).to be(true)
      expect(result[:message]).to include("/usr/bin/chromium")
    end
  end
end
