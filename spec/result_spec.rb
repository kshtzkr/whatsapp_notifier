require "spec_helper"

RSpec.describe WhatsAppNotifier::Result do
  it "reports success and failure predicates" do
    success_result = described_class.new(success: true, provider: :official_api)
    failure_result = described_class.new(success: false, provider: :official_api)

    expect(success_result).to be_success
    expect(success_result).not_to be_failure
    expect(failure_result).to be_failure
  end
end
