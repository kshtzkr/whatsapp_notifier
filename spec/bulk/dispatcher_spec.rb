require "spec_helper"

RSpec.describe WhatsAppNotifier::Bulk::Dispatcher do
  let(:config) do
    WhatsAppNotifier::Configuration.new.tap do |c|
      c.bulk_base_delay_seconds = 0
      c.bulk_jitter_seconds = 0
      c.bulk_max_recipients = 5
      c.bulk_max_attempts = 2
      c.bulk_retryable_error_codes = %i[rate_limited]
    end
  end

  it "validates messages input type" do
    dispatcher = described_class.new(client: double, configuration: config, sleeper: ->(_seconds) {})

    expect { dispatcher.deliver("x") }.to raise_error(WhatsAppNotifier::ConfigurationError, /array/)
  end

  it "validates recipient limit" do
    dispatcher = described_class.new(client: double, configuration: config, sleeper: ->(_seconds) {})
    messages = Array.new(6) { { to: "+1", body: "a" } }

    expect { dispatcher.deliver(messages) }.to raise_error(WhatsAppNotifier::ConfigurationError, /exceeded/)
  end

  it "delivers messages and summarizes result counts" do
    client = double
    allow(client).to receive(:deliver).and_return(
      WhatsAppNotifier::Result.new(success: true, provider: :web_automation),
      WhatsAppNotifier::Result.new(success: false, provider: :web_automation, error_code: :blocked)
    )
    dispatcher = described_class.new(client: client, configuration: config, sleeper: ->(_seconds) {})

    summary = dispatcher.deliver([{ to: "+1", body: "a" }, { to: "+2", body: "b" }])

    expect(summary[:total]).to eq(2)
    expect(summary[:success]).to eq(1)
    expect(summary[:failed]).to eq(1)
  end

  it "waits on provider wait_seconds and retries retryable failures" do
    slept = []
    client = double
    allow(client).to receive(:deliver).and_return(
      WhatsAppNotifier::Result.new(success: false, provider: :web_automation, error_code: :rate_limited),
      WhatsAppNotifier::Result.new(success: true, provider: :web_automation, wait_seconds: 2)
    )
    dispatcher = described_class.new(client: client, configuration: config, sleeper: ->(seconds) { slept << seconds })

    summary = dispatcher.deliver([{ to: "+1", body: "a" }])

    expect(summary[:success]).to eq(1)
    expect(slept).to include(2)
    expect(client).to have_received(:deliver).twice
  end

  it "deduplicates idempotency keys within one bulk run" do
    client = double
    allow(client).to receive(:deliver).and_return(WhatsAppNotifier::Result.new(success: true, provider: :web_automation))
    dispatcher = described_class.new(client: client, configuration: config, sleeper: ->(_seconds) {})

    summary = dispatcher.deliver(
      [
        { to: "+1", body: "a", idempotency_key: "k1" },
        { to: "+2", body: "b", idempotency_key: "k1" }
      ]
    )

    expect(summary[:results].last.error_code).to eq(:duplicate_idempotency_key)
    expect(client).to have_received(:deliver).once
  end
end
