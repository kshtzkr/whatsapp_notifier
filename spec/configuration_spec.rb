require "spec_helper"

RSpec.describe WhatsAppNotifier::Configuration do
  it "has safe defaults" do
    config = described_class.new

    expect(config.provider).to eq(:official_api)
    expect(config.web_automation_enabled).to be(false)
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
end
