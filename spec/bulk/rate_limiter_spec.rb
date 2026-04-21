require "spec_helper"

RSpec.describe WhatsAppNotifier::Bulk::RateLimiter do
  it "sleeps with base delay and jitter" do
    slept = []
    limiter = described_class.new(
      base_delay: 1.0,
      jitter: 0.5,
      sleeper: ->(seconds) { slept << seconds },
      rng: Random.new(123)
    )

    limiter.wait_before_next

    expect(slept.length).to eq(1)
    expect(slept.first).to be_between(1.0, 1.5)
  end

  it "does not sleep for non-positive delay" do
    slept = []
    limiter = described_class.new(base_delay: 0, jitter: 0, sleeper: ->(seconds) { slept << seconds })

    limiter.wait_before_next

    expect(slept).to be_empty
  end
end
