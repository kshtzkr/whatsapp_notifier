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

  it "yields the http connection to run the request" do
    response = http_success(body: { "success" => true })
    http = instance_double(Net::HTTP, request: response)
    allow(Net::HTTP).to receive(:start).and_yield(http).and_return(response)

    result = adapter.send_message(
      payload: { to: "+1", body: "hi", metadata: {}, idempotency_key: "k1" },
      session: {}
    )

    expect(result).to include(success: true)
    expect(http).to have_received(:request)
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

  it "fetches inbound messages from a bare array body" do
    body = [
      { "from" => "919@c.us", "body" => "hi", "messageId" => "m1", "timestamp" => 123, "type" => "chat" }
    ]
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    messages = adapter.fetch_inbound(metadata: { user_id: "u-1" })

    expect(messages).to eq([{ from: "919@c.us", body: "hi", message_id: "m1", timestamp: 123, type: "chat" }])
  end

  it "fetches inbound from a {messages:} envelope and accepts the message_id alias" do
    body = { "messages" => [{ "from" => "918@c.us", "body" => "yo", "message_id" => "m2", "timestamp" => 9 }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    messages = adapter.fetch_inbound(metadata: { user_id: "u-1" })

    expect(messages.first).to include(from: "918@c.us", message_id: "m2", type: nil)
  end

  it "returns an empty array when the inbound body is empty" do
    empty = instance_double(Net::HTTPOK, body: "", code: "200", is_a?: true)
    allow(Net::HTTP).to receive(:start).and_return(empty)

    expect(adapter.fetch_inbound(metadata: {})).to eq([])
  end

  it "raises when the inbound fetch fails" do
    allow(Net::HTTP).to receive(:start).and_return(http_failure(code: "500", body: JSON.generate({ error: "down" })))

    expect { adapter.fetch_inbound(metadata: {}) }.to raise_error(/service request failed/)
  end

  it "maps the 0.7.0 media and sender keys when the wire payload carries them" do
    body = { "messages" => [{
      "from" => "919@c.us", "body" => "", "messageId" => "m1", "timestamp" => 123, "type" => "image",
      "hasMedia" => true, "mediaStatus" => "available", "mediaMime" => "image/jpeg",
      "mediaFilename" => "beach.jpg", "mediaSize" => 1024, "senderName" => "Asha"
    }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: { user_id: "u-1" }).first

    expect(message).to include(
      has_media: true, media_status: "available", media_mime: "image/jpeg",
      media_filename: "beach.jpg", media_size: 1024, sender_name: "Asha"
    )
  end

  it "accepts snake_case wire aliases and maps an unavailable verdict's error" do
    body = { "messages" => [{
      "from" => "919@c.us", "body" => "", "message_id" => "m1", "timestamp" => 1, "type" => "video",
      "has_media" => true, "media_status" => "unavailable", "media_error" => "unsupported_type"
    }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: {}).first

    expect(message).to include(has_media: true, media_status: "unavailable", media_error: "unsupported_type")
    expect(message).not_to have_key(:media_mime)
  end

  # A 0.6.0 service sends no media keys at all — the mapped hash must omit
  # them (not nil them), because hosts key-gate ingest on has_media presence.
  it "omits the media keys entirely for 0.6.0-shaped payloads" do
    body = [{ "from" => "919@c.us", "body" => "hi", "messageId" => "m1", "timestamp" => 123, "type" => "chat" }]
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: {}).first

    expect(message.keys).to match_array(%i[from body message_id timestamp type])
  end

  def binary_response(code:, body: "", headers: {})
    response = double("binary response", code: code, body: body)
    allow(response).to receive(:is_a?) { |klass| code == "200" && klass == Net::HTTPSuccess }
    allow(response).to receive(:[]) { |name| headers[name] }
    response
  end

  def run_binary_request(response)
    captured = nil
    http = double("http")
    allow(http).to receive(:request) { |req| captured = req; response }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }
    -> { captured }
  end

  it "fetches media bytes with mime, filename and size on a dedicated binary path" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return(nil)
    response = binary_response(
      code: "200", body: "\xFF\xD8raw-jpeg".b,
      headers: { "Content-Type" => "image/jpeg", "Content-Disposition" => 'attachment; filename="beach.jpg"' }
    )
    captured = run_binary_request(response)

    media = adapter.fetch_media(message_id: "true_919@c.us_ABC", metadata: { user_id: "u-1" })

    expect(media).to eq(body: "\xFF\xD8raw-jpeg".b, mime: "image/jpeg", filename: "beach.jpg", size: 10)
    expect(captured.call.path).to eq("/media/u-1/true_919@c.us_ABC")
    expect(captured.call["X-WA-Token"]).to be_nil # env unset -> no token header
  end

  it "returns nil when the service has no copy of the media (404)" do
    allow(Net::HTTP).to receive(:start).and_return(binary_response(code: "404", body: '{"error":"not_found"}'))

    expect(adapter.fetch_media(message_id: "m1", metadata: {})).to be_nil
  end

  it "raises on non-404 media fetch failures" do
    allow(Net::HTTP).to receive(:start).and_return(binary_response(code: "500", body: "boom"))

    expect { adapter.fetch_media(message_id: "m1", metadata: {}) }.to raise_error(/service request failed \(500\)/)
  end

  it "sends X-WA-Token on the media fetch when WHATSAPP_WEBHOOK_TOKEN is set" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return("sekrit")
    response = binary_response(code: "200", body: "x", headers: { "Content-Type" => "audio/ogg" })
    captured = run_binary_request(response)

    media = adapter.fetch_media(message_id: "m1", metadata: { user_id: "u-1" })

    expect(captured.call["X-WA-Token"]).to eq("sekrit")
    expect(media).to include(mime: "audio/ogg", filename: nil, size: 1)
  end

  it "strips path and query characters from the message id before building the URL" do
    response = binary_response(code: "404")
    captured = run_binary_request(response)

    adapter.fetch_media(message_id: "../m1?x=1#f", metadata: { user_id: "u-1" })

    expect(captured.call.path).to eq("/media/u-1/..m1x1f")
  end

  it "deletes media via the JSON control plane with the token attached" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return("sekrit")
    response = http_success(body: { "success" => true })
    captured = nil
    http = double("http")
    allow(http).to receive(:request) { |req| captured = req; response }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }

    expect(adapter.delete_media(message_id: "m/1", metadata: { user_id: "u-1" })).to eq(success: true)
    expect(captured).to be_a(Net::HTTP::Delete)
    expect(captured.path).to eq("/media/u-1/m1")
    expect(captured["X-WA-Token"]).to eq("sekrit")
  end

  it "defaults delete_media success to false when the service omits it" do
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: {}))

    expect(adapter.delete_media(message_id: "m1", metadata: {})).to eq(success: false)
  end

  it "logs out via the service" do
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: { "success" => true }))

    expect(adapter.logout(metadata: { user_id: "u-1" })).to eq(success: true)
  end

  it "defaults logout success to false when the service omits it" do
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: {}))

    expect(adapter.logout(metadata: {})).to eq(success: false)
  end

  # The "default" session for metadata without a user_id is documented public
  # API (README: "omit metadata for a default shared session") — pin it.
  it "falls back to the shared 'default' user when metadata has no user_id" do
    allow(Net::HTTP::Get).to receive(:new).and_call_original
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: { "qr" => "data:image/png;base64,qr" }))

    adapter.fetch_qr_code(metadata: {})

    expect(Net::HTTP::Get).to have_received(:new).with("/qr/default")
  end

  it "executes the request inside the Net::HTTP block" do
    fake_http = instance_double(Net::HTTP)
    allow(fake_http).to receive(:request).and_return(http_success(body: { "qr" => "data:image/png;base64,x" }))
    # Invoke the block so the real request path runs (other specs stub it away).
    allow(Net::HTTP).to receive(:start) { |*_args, &blk| blk.call(fake_http) }

    expect(adapter.fetch_qr_code(metadata: { user_id: 1 })).to eq("data:image/png;base64,x")
    expect(fake_http).to have_received(:request)
  end
end
