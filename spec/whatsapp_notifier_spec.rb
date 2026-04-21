require "spec_helper"

RSpec.describe WhatsAppNotifier do
  it "configures and validates settings" do
    described_class.configure do |config|
      config.provider = :official_api
      config.bulk_max_recipients = 10
      config.bulk_max_attempts = 2
    end

    expect(described_class.configuration.provider).to eq(:official_api)
  end

  it "delegates single delivery to client" do
    sender = lambda { |payload| { success: true, message_id: "m1", metadata: payload } }
    described_class.configure { |config| config.official_sender = sender }

    result = described_class.deliver(to: "+91", body: "hi", metadata: { a: 1 }, idempotency_key: "k1")

    expect(result).to be_success
    expect(result.message_id).to eq("m1")
  end

  it "delegates bulk delivery to client" do
    described_class.configure do |config|
      config.official_sender = lambda { |_payload| { success: true } }
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
        config.web_adapter = double(fetch_qr_code: "qr-via-module", send_message: { success: true, session: {} })
      end

      expect(described_class.scan_qr).to eq("qr-via-module")
    end
  end
end
