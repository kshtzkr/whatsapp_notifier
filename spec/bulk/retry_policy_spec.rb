require "spec_helper"

RSpec.describe WhatsAppNotifier::Bulk::RetryPolicy do
  it "retries for retryable failures and returns final result" do
    policy = described_class.new(max_attempts: 3, retryable_error_codes: %i[rate_limited])
    attempts = 0

    result = policy.with_retries do
      attempts += 1
      if attempts < 3
        WhatsAppNotifier::Result.new(success: false, provider: :official_api, error_code: :rate_limited)
      else
        WhatsAppNotifier::Result.new(success: true, provider: :official_api)
      end
    end

    expect(attempts).to eq(3)
    expect(result).to be_success
  end

  it "does not retry non-retryable failures" do
    policy = described_class.new(max_attempts: 3, retryable_error_codes: %i[rate_limited])
    attempts = 0

    result = policy.with_retries do
      attempts += 1
      WhatsAppNotifier::Result.new(success: false, provider: :official_api, error_code: :blocked)
    end

    expect(attempts).to eq(1)
    expect(result).to be_failure
  end
end
