require "spec_helper"

RSpec.describe WhatsAppNotifier::Configuration do
  it "has safe defaults" do
    config = described_class.new

    expect(config.provider).to eq(:web_automation)
    expect(config.web_automation_enabled).to be(true)
    expect(config.bulk_max_recipients).to be > 0
  end

  it "raises when provider is missing" do
    config = described_class.new
    config.provider = nil

    expect { config.validate! }.to raise_error(WhatsAppNotifier::ConfigurationError, /provider is required/)
  end

  it "raises when bulk_max_recipients is invalid" do
    config = described_class.new
    config.bulk_max_recipients = 0

    expect { config.validate! }.to raise_error(WhatsAppNotifier::ConfigurationError, /bulk_max_recipients/)
  end

  it "raises when bulk_max_attempts is invalid" do
    config = described_class.new
    config.bulk_max_attempts = 0

    expect { config.validate! }.to raise_error(WhatsAppNotifier::ConfigurationError, /bulk_max_attempts/)
  end

  it "raises when provider is not web_automation" do
    config = described_class.new
    config.provider = :official_api
    config.web_adapter = double(send_message: {}, fetch_qr_code: "qr", connection_status: {})

    expect { config.validate! }.to raise_error(WhatsAppNotifier::ConfigurationError, /only :web_automation provider is supported/)
  end

  it "raises when web_adapter is missing required methods" do
    config = described_class.new
    config.web_adapter = Object.new

    expect { config.validate! }.to raise_error(WhatsAppNotifier::ConfigurationError, /web_adapter must be configured/)
  end

  it "exposes an inbound message handler accessor that defaults to nil" do
    config = described_class.new
    expect(config.on_inbound_message_handler).to be_nil

    handler = ->(msg) { msg }
    config.on_inbound_message_handler = handler
    expect(config.on_inbound_message_handler).to eq(handler)
  end

  it "validates without requiring fetch_inbound on the adapter (inbound is optional)" do
    config = described_class.new
    config.web_adapter = double(send_message: {}, fetch_qr_code: "qr", connection_status: {})

    expect { config.validate! }.not_to raise_error
  end
end
