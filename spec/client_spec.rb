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
end
