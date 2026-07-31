require "spec_helper"
require "net/http"

RSpec.describe WhatsAppNotifier::ErrorCode do
  describe ".from_exception" do
    it "classifies a service error by its HTTP status, not its body text" do
      # A 401 body that happens to mention a number must still read as auth.
      error = WhatsAppNotifier::ServiceError.new(
        "service request failed (401): No saved WhatsApp session for this user — pair via QR first",
        status: "401"
      )

      expect(described_class.from_exception(error)).to eq(:auth_required)
    end

    it "classifies a 403 as auth and a 429 as rate limiting" do
      forbidden = WhatsAppNotifier::ServiceError.new("nope", status: 403)
      throttled = WhatsAppNotifier::ServiceError.new("slow down", status: "429")

      expect(described_class.from_exception(forbidden)).to eq(:auth_required)
      expect(described_class.from_exception(throttled)).to eq(:rate_limited)
    end

    # The service 422s a malformed REQUEST (a host bug), never a bad number,
    # so it must NOT be classified as :invalid_phone.
    it "leaves a 422 unclassified" do
      error = WhatsAppNotifier::ServiceError.new("service request failed (422): `to` is required", status: 422)

      expect(described_class.from_exception(error)).to eq(:delivery_exception)
    end

    it "classifies socket failures as service_unreachable" do
      expect(described_class.from_exception(Errno::ECONNREFUSED.new)).to eq(:service_unreachable)
      expect(described_class.from_exception(SocketError.new("getaddrinfo"))).to eq(:service_unreachable)
      expect(described_class.from_exception(Net::OpenTimeout.new)).to eq(:service_unreachable)
    end

    # A read timeout is NOT the same as a connect timeout: the request went
    # out, so the send may well have landed.
    it "classifies a read timeout as :timeout, separate from :service_unreachable" do
      expect(described_class.from_exception(Net::ReadTimeout.new)).to eq(:timeout)
    end

    it "falls back to the message when the class and status say nothing" do
      expect(described_class.from_exception(RuntimeError.new("No LID for 919999000001"))).to eq(:recipient_unresolved)
    end

    it "falls back to the message for a 500 carrying a library error" do
      error = WhatsAppNotifier::ServiceError.new("service request failed (500): No LID for 919999000001", status: 500)

      expect(described_class.from_exception(error)).to eq(:recipient_unresolved)
    end

    it "leaves an opaque exception unclassified" do
      expect(described_class.from_exception(RuntimeError.new("Evaluation failed: e"))).to eq(:delivery_exception)
    end
  end

  describe ".from_message" do
    {
      "No LID for 919999000001" => :recipient_unresolved,
      "Phone number is not registered" => :not_on_whatsapp,
      "wid error: invalid wid" => :invalid_phone,
      "User not authenticated" => :auth_required,
      "Connection refused - connect(2) for 127.0.0.1:3001" => :service_unreachable,
      "execution expired" => :timeout,
      "Too Many Requests" => :rate_limited
    }.each do |text, code|
      it "reads #{text.inspect} as #{code}" do
        expect(described_class.from_message(text)).to eq(code)
      end
    end

    it "returns the catch-all for text it cannot place" do
      expect(described_class.from_message("something new")).to eq(:delivery_exception)
      expect(described_class.from_message(nil)).to eq(:delivery_exception)
    end
  end

  describe ".normalize" do
    it "folds the service's synonyms into one code" do
      expect(described_class.normalize("unauthenticated")).to eq(:auth_required)
      expect(described_class.normalize("NUMBER_NOT_REGISTERED")).to eq(:not_on_whatsapp)
      expect(described_class.normalize(:throttled)).to eq(:rate_limited)
    end

    it "returns nil for a blank code so callers fall back to their own guess" do
      expect(described_class.normalize(nil)).to be_nil
      expect(described_class.normalize("  ")).to be_nil
    end

    # A newer service may introduce a code before the gem knows it — pass it
    # through rather than flattening it, but only if it looks like an
    # identifier.
    it "passes an unknown identifier-shaped code through" do
      expect(described_class.normalize("queue_full")).to eq(:queue_full)
    end

    it "flattens code-shaped garbage to the catch-all" do
      expect(described_class.normalize("<html>502 Bad Gateway</html>")).to eq(:delivery_exception)
    end
  end

  it "lists every code it can return" do
    expect(described_class::ALL).to include(described_class::UNCLASSIFIED)
  end
end
