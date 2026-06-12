require "spec_helper"

RSpec.describe WhatsAppNotifier::Client do
  let(:config) { WhatsAppNotifier::Configuration.new }

  it "routes to web automation provider by default" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true }
      )
      client = described_class.new(configuration: config)

      result = client.deliver(to: "+1", body: "h")
      expect(result.provider).to eq(:web_automation)
    end
  end

  it "raises for unknown provider" do
    client = described_class.new(configuration: config)
    expect { client.deliver(to: "+1", body: "h", provider: :bad) }.to raise_error(WhatsAppNotifier::ConfigurationError, /unknown provider/)
  end

  it "delegates bulk and qr operations" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.bulk_base_delay_seconds = 0
      config.bulk_jitter_seconds = 0
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "QR_REQUIRED", authenticated: false }
      )
      client = described_class.new(configuration: config)

      summary = client.deliver_bulk([{ to: "+1", body: "a" }], sleeper: ->(_seconds) {})
      expect(summary[:success]).to eq(1)

      qr = client.scan_qr(provider: :web_automation)
      expect(qr).to eq("qr")

      status = client.connection_status(provider: :web_automation)
      expect(status).to include(state: "QR_REQUIRED")
    end
  end

  it "delegates fetch_inbound to the provider" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true },
        fetch_inbound: [{ from: "a@c.us", body: "hi" }]
      )
      client = described_class.new(configuration: config)

      expect(client.fetch_inbound(provider: :web_automation)).to eq([{ from: "a@c.us", body: "hi" }])
    end
  end

  it "delegates fetch_media and delete_media to the provider" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true },
        fetch_media: { body: "bytes", mime: "image/jpeg", filename: nil, size: 5 },
        delete_media: { success: true }
      )
      client = described_class.new(configuration: config)

      expect(client.fetch_media(message_id: "m1", provider: :web_automation, metadata: { user_id: 1 }))
        .to include(body: "bytes", size: 5)
      expect(client.delete_media(message_id: "m1", provider: :web_automation, metadata: { user_id: 1 }))
        .to eq(success: true)
    end
  end

  it "delegates list_chats and fetch_history to the provider" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true },
        list_chats: [{ id: "919@c.us", name: "Asha", last_message_at: 9 }],
        fetch_history: [{ from: "919@c.us", body: "old", message_id: "h1" }]
      )
      config.web_adapter = adapter
      client = described_class.new(configuration: config)

      expect(client.list_chats(provider: :web_automation, metadata: { user_id: 1 }))
        .to eq([{ id: "919@c.us", name: "Asha", last_message_at: 9 }])
      expect(client.fetch_history(chat_id: "919@c.us", provider: :web_automation, metadata: { user_id: 1 }))
        .to eq([{ from: "919@c.us", body: "old", message_id: "h1" }])
      # The default page size survives the delegation chain untouched.
      expect(adapter).to have_received(:fetch_history).with(chat_id: "919@c.us", limit: 50, metadata: { user_id: 1 })
    end
  end

  it "delegates logout to the provider" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true },
        logout: { success: true }
      )
      client = described_class.new(configuration: config)

      expect(client.logout(provider: :web_automation, metadata: { user_id: 1 })).to eq(success: true)
    end
  end
end
