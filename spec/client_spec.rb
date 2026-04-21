require "spec_helper"

RSpec.describe WhatsAppNotifier::Client do
  let(:config) { WhatsAppNotifier::Configuration.new }

  it "routes to official provider by default" do
    config.official_sender = ->(_payload) { { success: true, message_id: "x" } }
    client = described_class.new(configuration: config)

    result = client.deliver(to: "+1", body: "hello")

    expect(result).to be_success
    expect(result.provider).to eq(:official_api)
  end

  it "routes to explicit provider" do
    Dir.mktmpdir do |dir|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(send_message: { success: true, session: {} }, fetch_qr_code: "qr")
      client = described_class.new(configuration: config)

      result = client.deliver(to: "+1", body: "h", provider: :web_automation)
      expect(result.provider).to eq(:web_automation)
    end
  end

  it "raises for unknown provider" do
    client = described_class.new(configuration: config)
    expect { client.deliver(to: "+1", body: "h", provider: :bad) }.to raise_error(WhatsAppNotifier::ConfigurationError, /unknown provider/)
  end

  it "delegates bulk and qr operations" do
    Dir.mktmpdir do |dir|
      config.official_sender = ->(_payload) { { success: true } }
      config.bulk_base_delay_seconds = 0
      config.bulk_jitter_seconds = 0
      config.web_automation_enabled = true
      config.web_session_path = File.join(dir, "session.json")
      config.web_adapter = double(send_message: { success: true, session: {} }, fetch_qr_code: "qr")
      client = described_class.new(configuration: config)

      summary = client.deliver_bulk([{ to: "+1", body: "a" }], sleeper: ->(_seconds) {})
      expect(summary[:success]).to eq(1)

      qr = client.scan_qr(provider: :web_automation)
      expect(qr).to eq("qr")
    end
  end
end
