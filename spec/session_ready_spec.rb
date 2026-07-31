require "spec_helper"

# WhatsAppNotifier.session_ready? — the one call hosts make before sending, so
# they stop each writing their own "authenticated == true, rescue to false".
RSpec.describe "session readiness" do
  def configure(adapter)
    WhatsAppNotifier.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = adapter
      config.logger = Logger.new(nil)
      config.warn_on_risky_provider = false
    end
  end

  def adapter_returning(status)
    adapter = double(send_message: { success: true, session: {} }, fetch_qr_code: "qr")
    allow(adapter).to receive(:connection_status).and_return(status)
    adapter
  end

  def adapter_raising(error)
    adapter = double(send_message: { success: true, session: {} }, fetch_qr_code: "qr")
    allow(adapter).to receive(:connection_status).and_raise(error)
    adapter
  end

  it "is true only when the service reports an authenticated session" do
    configure(adapter_returning(state: "AUTHENTICATED", authenticated: true))

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(true)
  end

  it "is false when the session is not authenticated" do
    configure(adapter_returning(state: "QR_REQUIRED", authenticated: false))

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(false)
  end

  # Truthy-but-not-true (a "yes" string from a sloppy adapter) must not read
  # as ready — the check is deliberately exact.
  it "is false for a truthy non-true authenticated value" do
    configure(adapter_returning(authenticated: "yes"))

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(false)
  end

  it "is false when the adapter answers with something that is not a hash" do
    configure(adapter_returning(nil))

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(false)
  end

  # An unreachable status endpoint means the service is down, so sends can't
  # succeed either — not ready, and logged rather than raised.
  it "is false and logs when the status endpoint is unreachable" do
    logger = double(warn: true)
    configure(adapter_raising(Errno::ECONNREFUSED))
    WhatsAppNotifier.configuration.logger = logger

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(false)
    expect(logger).to have_received(:warn).with(/session_ready\? failed/)
  end

  it "survives a nil logger" do
    configure(adapter_raising(Errno::ECONNREFUSED))
    WhatsAppNotifier.configuration.logger = nil

    expect(WhatsAppNotifier.session_ready?(user_id: 7)).to be(false)
  end

  # A ConfigurationError is a boot-time mistake in the HOST. Swallowing it
  # would quietly park every campaign behind a "session down" backoff.
  it "does not swallow a configuration error" do
    configure(adapter_returning(authenticated: true))
    WhatsAppNotifier.configuration.web_automation_enabled = false

    expect { WhatsAppNotifier.session_ready?(user_id: 7) }
      .to raise_error(WhatsAppNotifier::ConfigurationError, /disabled/)
  end

  it "passes the user id through as status metadata" do
    adapter = adapter_returning(authenticated: true)
    configure(adapter)

    WhatsAppNotifier.session_ready?(user_id: 42)

    expect(adapter).to have_received(:connection_status).with(metadata: { user_id: 42 })
  end

  it "accepts a metadata hash instead of user_id" do
    adapter = adapter_returning(authenticated: true)
    configure(adapter)

    WhatsAppNotifier.session_ready?(metadata: { user_id: 9, tenant: "x" })

    expect(adapter).to have_received(:connection_status).with(metadata: { user_id: 9, tenant: "x" })
  end

  it "asks for the default session when neither is given" do
    adapter = adapter_returning(authenticated: true)
    configure(adapter)

    WhatsAppNotifier.session_ready?

    expect(adapter).to have_received(:connection_status).with(metadata: {})
  end

  it "is not implemented by a bare provider" do
    provider = WhatsAppNotifier::Providers::Base.new(configuration: WhatsAppNotifier.configuration)

    expect { provider.session_ready? }.to raise_error(NotImplementedError)
  end
end
