require "spec_helper"
require "json"

RSpec.describe WhatsAppNotifier::WebAdapter do
  let(:adapter) { described_class.new(base_url: "http://127.0.0.1:3001") }

  def http_success(code: "200", body: {})
    instance_double(Net::HTTPOK, body: JSON.generate(body), code: code, is_a?: true)
  end

  def http_failure(code: "500", body: "boom")
    instance_double(Net::HTTPInternalServerError, body: body, code: code, is_a?: false)
  end

  it "sends a message using the service" do
    response = http_success(body: { "success" => true })
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = adapter.send_message(
      payload: { to: "+1", body: "hi", metadata: { user_id: 1 }, idempotency_key: "k1" },
      session: {}
    )

    expect(result).to include(success: true, message_id: "k1")
  end

  it "fetches qr and status data" do
    qr_response = http_success(body: { "qr" => "data:image/png;base64,qr" })
    status_response = http_success(body: { "state" => "AUTHENTICATED", "authenticated" => true, "hasQR" => false })
    allow(Net::HTTP).to receive(:start).and_return(qr_response, status_response)

    qr = adapter.fetch_qr_code(metadata: { user_id: "u-1" })
    status = adapter.connection_status(metadata: { user_id: "u-1" })

    expect(qr).to include("data:image")
    expect(status).to include(state: "AUTHENTICATED", authenticated: true, has_qr: false)
  end

  it "raises for non-success service responses" do
    allow(Net::HTTP).to receive(:start).and_return(http_failure(code: "422", body: JSON.generate({ error: "bad request" })))

    expect do
      adapter.fetch_qr_code(metadata: {})
    end.to raise_error(/service request failed/)
  end

  it "handles empty and invalid response bodies gracefully" do
    empty_body = instance_double(Net::HTTPOK, body: "", code: "200", is_a?: true)
    invalid_body = instance_double(Net::HTTPInternalServerError, body: "raw-error", code: "500", is_a?: false)
    allow(Net::HTTP).to receive(:start).and_return(empty_body, invalid_body)

    expect(adapter.fetch_qr_code(metadata: {})).to be_nil
    expect { adapter.connection_status(metadata: {}) }.to raise_error(/raw-error/)
  end
end
