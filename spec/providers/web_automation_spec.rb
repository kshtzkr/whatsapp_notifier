require "spec_helper"

RSpec.describe WhatsAppNotifier::Providers::WebAutomation do
  def build_config(path:, adapter:, enabled: true, warn: true, logger: Logger.new(nil))
    config = WhatsAppNotifier::Configuration.new
    config.web_session_path = path
    config.web_adapter = adapter
    config.web_automation_enabled = enabled
    config.warn_on_risky_provider = warn
    config.logger = logger
    config
  end

  it "raises on scan when provider disabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr")
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.scan_qr }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "scans qr when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr")
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.scan_qr).to eq("qr")
    end
  end

  it "delivers and persists session from adapter response" do
    Dir.mktmpdir do |dir|
      logger = double(warn: true)
      adapter = double
      allow(adapter).to receive(:send_message).and_return(
        success: true,
        message_id: "w1",
        session: { active: true, token: "x" }
      )
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, logger: logger)
      provider = described_class.new(configuration: config)

      result = provider.deliver(to: "+1", body: "h")
      expect(result).to be_success
      expect(result.message_id).to eq("w1")

      provider.deliver(to: "+1", body: "h")
      expect(logger).to have_received(:warn).once
    end
  end

  it "returns failure on adapter error" do
    Dir.mktmpdir do |dir|
      adapter = double
      allow(adapter).to receive(:send_message).and_raise("crash")
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      result = provider.deliver(to: "+1", body: "h")
      expect(result).to be_failure
      expect(result.error_code).to eq(:delivery_exception)
    end
  end

  it "raises for missing adapter methods in scan" do
    Dir.mktmpdir do |dir|
      adapter = Object.new
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect { provider.scan_qr }.to raise_error(WhatsAppNotifier::ConfigurationError, /web_adapter/)
    end
  end
end
