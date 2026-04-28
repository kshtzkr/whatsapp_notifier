require "spec_helper"

RSpec.describe WhatsAppNotifier do
  it "configures and validates settings" do
    described_class.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true }
      )
      config.bulk_max_recipients = 10
      config.bulk_max_attempts = 2
    end

    expect(described_class.configuration.provider).to eq(:web_automation)
  end

  it "delegates single delivery to client" do
    adapter = double
    allow(adapter).to receive(:send_message).and_return(success: true, message_id: "m1", metadata: {}, session: {})
    allow(adapter).to receive(:fetch_qr_code).and_return("qr")
    allow(adapter).to receive(:connection_status).and_return(state: "AUTHENTICATED", authenticated: true)
    described_class.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = adapter
    end

    result = described_class.deliver(to: "+91", body: "hi", metadata: { a: 1 }, idempotency_key: "k1")

    expect(result).to be_success
    expect(result.message_id).to eq("m1")
  end

  it "delegates bulk delivery to client" do
    described_class.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = double(
        send_message: { success: true, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true }
      )
      config.bulk_base_delay_seconds = 0
      config.bulk_jitter_seconds = 0
    end

    summary = described_class.deliver_bulk([{ to: "+1", body: "a" }], sleeper: ->(_seconds) {})

    expect(summary[:total]).to eq(1)
    expect(summary[:success]).to eq(1)
  end

  it "delegates qr scan through module API" do
    Dir.mktmpdir do |dir|
      described_class.configure do |config|
        config.provider = :web_automation
        config.web_automation_enabled = true
        config.web_session_path = File.join(dir, "session.json")
        config.web_adapter = double(
          fetch_qr_code: "qr-via-module",
          send_message: { success: true, session: {} },
          connection_status: { state: "QR_REQUIRED", authenticated: false }
        )
      end

      expect(described_class.scan_qr).to eq("qr-via-module")
    end
  end

  it "delegates status through module API" do
    described_class.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = double(
        fetch_qr_code: "qr-via-module",
        send_message: { success: true, session: {} },
        connection_status: { state: "AUTHENTICATED", authenticated: true }
      )
    end

    expect(described_class.connection_status).to include(state: "AUTHENTICATED", authenticated: true)
  end

  it "exposes bundled service path" do
    expect(File.directory?(described_class.service_path)).to be(true)
  end

  it "delegates module helpers to client" do
    fake_client = double
    allow(fake_client).to receive(:deliver_bulk).and_return(total: 0, success: 0, failed: 0, results: [])
    allow(fake_client).to receive(:scan_qr).and_return("qr-code")
    allow(fake_client).to receive(:connection_status).and_return(state: "QR_REQUIRED")
    described_class.instance_variable_set(:@client, fake_client)

    expect(described_class.deliver_bulk([], provider: :web_automation)[:total]).to eq(0)
    expect(described_class.scan_qr(provider: :web_automation, metadata: { user_id: 1 })).to eq("qr-code")
    expect(described_class.connection_status(provider: :web_automation, metadata: { user_id: 1 })).to include(state: "QR_REQUIRED")
  end

end
