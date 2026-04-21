require "spec_helper"

RSpec.describe WhatsAppNotifier::Providers::OfficialApi do
  it "delivers with configured sender" do
    config = WhatsAppNotifier::Configuration.new
    config.official_sender = lambda { |_payload| { success: true, message_id: "ok" } }
    provider = described_class.new(configuration: config)

    result = provider.deliver(to: "+1", body: "hi")

    expect(result).to be_success
    expect(result.message_id).to eq("ok")
  end

  it "normalizes non-hash response" do
    config = WhatsAppNotifier::Configuration.new
    config.official_sender = ->(_payload) { true }
    provider = described_class.new(configuration: config)

    result = provider.deliver(to: "+1", body: "ok")

    expect(result).to be_success
  end

  it "returns failure on missing sender" do
    config = WhatsAppNotifier::Configuration.new
    provider = described_class.new(configuration: config)

    result = provider.deliver(to: "+1", body: "hi")

    expect(result).to be_failure
    expect(result.error_code).to eq(:delivery_exception)
  end

  it "returns failure when sender raises error" do
    config = WhatsAppNotifier::Configuration.new
    config.official_sender = ->(_payload) { raise "boom" }
    provider = described_class.new(configuration: config)

    result = provider.deliver(to: "+1", body: "hi")

    expect(result).to be_failure
    expect(result.error_message).to eq("boom")
  end
end
