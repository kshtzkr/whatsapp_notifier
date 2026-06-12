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

  it "fetches inbound via the adapter when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, fetch_inbound: [{ from: "x@c.us", body: "hi" }])
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.fetch_inbound(metadata: { user_id: 1 })).to eq([{ from: "x@c.us", body: "hi" }])
    end
  end

  it "raises on fetch_inbound when the provider is disabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, fetch_inbound: [])
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.fetch_inbound }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "raises on fetch_inbound when the adapter lacks inbound support" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {})
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect { provider.fetch_inbound }.to raise_error(WhatsAppNotifier::ConfigurationError, /inbound capture/)
    end
  end

  it "fetches and deletes media via the adapter when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(
        fetch_qr_code: "qr", connection_status: {},
        fetch_media: { body: "bytes", mime: "image/jpeg", filename: "a.jpg", size: 5 },
        delete_media: { success: true }
      )
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.fetch_media(message_id: "m1", metadata: { user_id: 1 })).to include(mime: "image/jpeg")
      expect(provider.delete_media(message_id: "m1", metadata: { user_id: 1 })).to eq(success: true)
      expect(adapter).to have_received(:fetch_media).with(message_id: "m1", metadata: { user_id: 1 })
      expect(adapter).to have_received(:delete_media).with(message_id: "m1", metadata: { user_id: 1 })
    end
  end

  it "raises on the media helpers when the provider is disabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, fetch_media: nil, delete_media: { success: true })
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.fetch_media(message_id: "m1") }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
      expect { provider.delete_media(message_id: "m1") }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "raises on the media helpers when the adapter lacks media support" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {})
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect { provider.fetch_media(message_id: "m1") }.to raise_error(WhatsAppNotifier::ConfigurationError, /media fetch/)
      expect { provider.delete_media(message_id: "m1") }.to raise_error(WhatsAppNotifier::ConfigurationError, /media deletion/)
    end
  end

  it "lists chats and fetches history via the adapter when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(
        fetch_qr_code: "qr", connection_status: {},
        list_chats: [{ id: "919@c.us", name: "Asha", last_message_at: 9 }],
        fetch_history: [{ from: "919@c.us", body: "old", message_id: "h1" }]
      )
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.list_chats(metadata: { user_id: 1 })).to eq([{ id: "919@c.us", name: "Asha", last_message_at: 9 }])
      expect(provider.fetch_history(chat_id: "919@c.us", limit: 20, metadata: { user_id: 1 }))
        .to eq([{ from: "919@c.us", body: "old", message_id: "h1" }])
      expect(adapter).to have_received(:list_chats).with(metadata: { user_id: 1 })
      expect(adapter).to have_received(:fetch_history).with(chat_id: "919@c.us", limit: 20, metadata: { user_id: 1 })
    end
  end

  it "defaults the history limit to 50 through the provider" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, fetch_history: [])
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      provider.fetch_history(chat_id: "919@c.us")

      expect(adapter).to have_received(:fetch_history).with(chat_id: "919@c.us", limit: 50, metadata: {})
    end
  end

  it "raises on the history helpers when the provider is disabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, list_chats: [], fetch_history: [])
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.list_chats }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
      expect { provider.fetch_history(chat_id: "919@c.us") }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "raises on the history helpers when the adapter lacks history support" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {})
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect { provider.list_chats }.to raise_error(WhatsAppNotifier::ConfigurationError, /chat listing/)
      expect { provider.fetch_history(chat_id: "919@c.us") }.to raise_error(WhatsAppNotifier::ConfigurationError, /history replay/)
    end
  end

  it "logs out via adapter when enabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, logout: { success: true })
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect(provider.logout(metadata: { user_id: 1 })).to eq(success: true)
    end
  end

  it "raises on logout when provider disabled" do
    Dir.mktmpdir do |dir|
      adapter = double(fetch_qr_code: "qr", connection_status: {}, logout: { success: true })
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter, enabled: false)
      provider = described_class.new(configuration: config)

      expect { provider.logout }.to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
    end
  end

  it "raises for missing adapter logout method" do
    Dir.mktmpdir do |dir|
      adapter = Object.new
      config = build_config(path: File.join(dir, "session.json"), adapter: adapter)
      provider = described_class.new(configuration: config)

      expect { provider.logout }.to raise_error(WhatsAppNotifier::ConfigurationError, /web_adapter/)
    end
  end
end
