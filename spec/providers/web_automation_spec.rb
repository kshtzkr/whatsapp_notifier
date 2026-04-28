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
      adapter = double(fetch_qr_code: "qr", connection_status: {})
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.scan_qr }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "scans qr when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {})
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
      allow(adapter).to receive(:fetch_qr_code).and_return("qr")
      allow(adapter).to receive(:connection_status).and_return(state: "AUTHENTICATED", authenticated: true)
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
      allow(adapter).to receive(:fetch_qr_code).and_return("qr")
      allow(adapter).to receive(:connection_status).and_return({})
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

  it "returns connection status via adapter" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: { state: "QR_REQUIRED", authenticated: false })
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.connection_status(metadata: { user_id: 1 })).to include(state: "QR_REQUIRED")
    end
  end

  it "isolates sessions by metadata user_id" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {})
      allow(adapter).to receive(:send_message).and_return(
        { success: true, session: { token: "user-a-token" } },
        { success: true, session: { token: "user-b-token" } }
      )
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      provider.deliver(to: "+1", body: "a", metadata: { user_id: "user-a" })
      provider.deliver(to: "+2", body: "b", metadata: { user_id: "user-b" })

      expect(adapter).to have_received(:send_message).with(payload: hash_including(metadata: { user_id: "user-a" }), session: {}).once
      expect(adapter).to have_received(:send_message).with(payload: hash_including(metadata: { user_id: "user-b" }), session: {}).once
    end
  end
end
