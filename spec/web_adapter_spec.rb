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

  # The 0.8.0 service returns the real WhatsApp message id — the key the host
  # dedupes the send's own fromMe echo on. It must beat the fabricated id.
  it "prefers the service-issued message id over the idempotency key" do
    response = http_success(body: { "success" => true, "messageId" => "true_919@c.us_ABC" })
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = adapter.send_message(
      payload: { to: "+1", body: "hi", metadata: { user_id: 1 }, idempotency_key: "k1" },
      session: {}
    )

    expect(result).to include(success: true, message_id: "true_919@c.us_ABC")
  end

  it "accepts the snake_case message_id alias in the send response" do
    response = http_success(body: { "success" => true, "message_id" => "true_919@c.us_DEF" })
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = adapter.send_message(payload: { to: "+1", body: "hi", metadata: {} }, session: {})

    expect(result).to include(message_id: "true_919@c.us_DEF")
  end

  # A 0.8.0 service that could not read the sent message's id answers
  # messageId: null — fall through to the 0.7.0 fabrication chain.
  it "falls back to the idempotency key when the service returns a null id" do
    response = http_success(body: { "success" => true, "messageId" => nil })
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = adapter.send_message(
      payload: { to: "+1", body: "hi", metadata: {}, idempotency_key: "k1" },
      session: {}
    )

    expect(result).to include(message_id: "k1")
  end

  it "fabricates a local id when neither the service nor the payload offers one" do
    response = http_success(body: { "success" => true })
    allow(Net::HTTP).to receive(:start).and_return(response)

    result = adapter.send_message(payload: { to: "+1", body: "hi", metadata: {} }, session: {})

    expect(result[:message_id]).to match(/\Alocal-\d+\z/)
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
  # Same contract for the 0.8.0 two-way keys: a customer message carries no
  # from_me/to, so they must be absent (hosts key-gate fromMe ingest too).
  it "omits the media and two-way keys entirely for plain inbound payloads" do
    body = [{ "from" => "919@c.us", "body" => "hi", "messageId" => "m1", "timestamp" => 123, "type" => "chat" }]
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: {}).first

    expect(message.keys).to match_array(%i[from body message_id timestamp type])
  end

  # 0.8.0 two-way capture: operator-sent messages arrive with fromMe + to —
  # `to` is the counterparty chat id the host threads the conversation on.
  it "maps the 0.8.0 two-way keys when the wire payload carries them" do
    body = { "messages" => [{
      "from" => "919000000001@c.us", "to" => "919@c.us", "fromMe" => true,
      "body" => "on my way", "messageId" => "true_919@c.us_OP1", "timestamp" => 5, "type" => "chat"
    }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: { user_id: "u-1" }).first

    expect(message).to include(
      from: "919000000001@c.us", to: "919@c.us", from_me: true,
      body: "on my way", message_id: "true_919@c.us_OP1"
    )
  end

  it "accepts the snake_case from_me wire alias" do
    body = { "messages" => [{
      "from" => "919000000001@c.us", "to" => "919@c.us", "from_me" => true,
      "body" => "done", "message_id" => "m9", "timestamp" => 9, "type" => "chat"
    }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    message = adapter.fetch_inbound(metadata: {}).first

    expect(message).to include(from_me: true, to: "919@c.us")
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

  # A 0.6.0 service mid-rollout has no /media routes — delete must degrade
  # like fetch_media's nil-on-404, not raise.
  it "returns success false when delete_media hits a 404" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "404", body: JSON.generate({ error: "not_found" })))

    expect(adapter.delete_media(message_id: "m1", metadata: {})).to eq(success: false)
  end

  it "still raises when delete_media fails with a non-404 code" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "500", body: JSON.generate({ error: "boom" })))

    expect { adapter.delete_media(message_id: "m1", metadata: {}) }
      .to raise_error(/service request failed \(500\)/)
  end

  it "refetches media via POST, mapping the success verdict and attaching the token" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return("sekrit")
    response = http_success(body: {
      "success" => true, "messageId" => "true_919@c.us_ABC", "mediaStatus" => "available",
      "mediaMime" => "image/jpeg", "mediaFilename" => "beach.jpg", "mediaSize" => 10
    })
    captured = nil
    http = double("http")
    allow(http).to receive(:request) { |req| captured = req; response }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }

    result = adapter.refetch_media(message_id: "true_919@c.us_ABC", chat_id: "919@c.us", metadata: { user_id: "u-1" })

    expect(result).to eq(mime: "image/jpeg", filename: "beach.jpg", size: 10, status: "available")
    expect(captured).to be_a(Net::HTTP::Post)
    expect(captured.path).to eq("/media/u-1/refetch")
    expect(captured["X-WA-Token"]).to eq("sekrit")
    expect(JSON.parse(captured.body)).to eq("messageId" => "true_919@c.us_ABC", "chatId" => "919@c.us")
  end

  it "accepts the snake_case media keys in the refetch response" do
    body = { "success" => true, "media_status" => "available", "media_mime" => "audio/ogg",
             "media_filename" => "vn.ogg", "media_size" => 3 }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    expect(adapter.refetch_media(message_id: "m1", chat_id: "919@c.us", metadata: {}))
      .to eq(mime: "audio/ogg", filename: "vn.ogg", size: 3, status: "available")
  end

  # Media gone upstream → the service answers 404 success:false; refetch
  # degrades to nil like fetch_media, so the host can grey the bubble out.
  it "returns nil when the refetch reports the media is gone (404)" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "404", body: JSON.generate({ success: false, mediaStatus: "unavailable", mediaError: "gone" })))

    expect(adapter.refetch_media(message_id: "m1", chat_id: "919@c.us", metadata: {})).to be_nil
  end

  # A success:false body that somehow arrives with a 2xx still degrades to nil.
  it "returns nil when the refetch response is unsuccessful" do
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: { "success" => false, "mediaError" => "gone" }))

    expect(adapter.refetch_media(message_id: "m1", chat_id: "919@c.us", metadata: {})).to be_nil
  end

  it "still raises when the refetch fails with a non-404 code" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "401", body: JSON.generate({ error: "User not authenticated" })))

    expect { adapter.refetch_media(message_id: "m1", chat_id: "919@c.us", metadata: {}) }
      .to raise_error(/service request failed \(401\)/)
  end

  it "lists chats with the token attached and maps the discovery keys" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return("sekrit")
    response = http_success(body: { "success" => true, "chats" => [
      { "id" => "919@c.us", "name" => "Asha", "lastMessageAt" => 1_717_000_000 },
      { "id" => "918@c.us", "name" => nil, "lastMessageAt" => nil }
    ] })
    captured = nil
    http = double("http")
    allow(http).to receive(:request) { |req| captured = req; response }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }

    chats = adapter.list_chats(metadata: { user_id: "u-1" })

    expect(chats).to eq([
      { id: "919@c.us", name: "Asha", last_message_at: 1_717_000_000 },
      { id: "918@c.us", name: nil, last_message_at: nil }
    ])
    expect(captured).to be_a(Net::HTTP::Get)
    expect(captured.path).to eq("/chats/u-1")
    expect(captured["X-WA-Token"]).to eq("sekrit")
  end

  it "accepts the snake_case last_message_at wire alias" do
    body = { "chats" => [{ "id" => "919@c.us", "name" => "Asha", "last_message_at" => 9 }] }
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: body))

    expect(adapter.list_chats(metadata: {}).first).to include(last_message_at: 9)
  end

  it "returns an empty chat list when the service omits the key" do
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: { "success" => true }))

    expect(adapter.list_chats(metadata: {})).to eq([])
  end

  # An unpaired or not-ready user answers 401 — the standard non-2xx raise
  # passes straight through to the caller.
  it "raises the standard error when the chat list is unauthorized" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "401", body: JSON.generate({ error: "User not authenticated" })))

    expect { adapter.list_chats(metadata: {}) }
      .to raise_error(/service request failed \(401\): User not authenticated/)
  end

  it "fetches history with the token, posting the chat id and clamped limit" do
    allow(ENV).to receive(:[]).and_call_original
    allow(ENV).to receive(:[]).with("WHATSAPP_WEBHOOK_TOKEN").and_return("sekrit")
    response = http_success(body: { "success" => true, "messages" => [
      { "from" => "919@c.us", "body" => "old reply", "messageId" => "h1", "timestamp" => 1, "type" => "chat" },
      { "from" => "919000000001@c.us", "to" => "919@c.us", "fromMe" => true,
        "body" => "old send", "messageId" => "h2", "timestamp" => 2, "type" => "chat" },
      { "from" => "919@c.us", "body" => "", "messageId" => "h3", "timestamp" => 3, "type" => "image",
        "hasMedia" => true, "mediaStatus" => "unavailable", "mediaError" => "history" }
    ] })
    captured = nil
    http = double("http")
    allow(http).to receive(:request) { |req| captured = req; response }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }

    messages = adapter.fetch_history(chat_id: "919@c.us", limit: 100_000, metadata: { user_id: "u-1" })

    expect(captured).to be_a(Net::HTTP::Post)
    expect(captured.path).to eq("/history/u-1")
    expect(captured["X-WA-Token"]).to eq("sekrit")
    expect(JSON.parse(captured.body)).to eq("chatId" => "919@c.us", "limit" => 200)

    # Same mapper as fetch_inbound: two-way keys on the operator's messages,
    # the by-design unavailable media verdict on history media.
    expect(messages[0]).to eq(from: "919@c.us", body: "old reply", message_id: "h1", timestamp: 1, type: "chat")
    expect(messages[1]).to include(from_me: true, to: "919@c.us", message_id: "h2")
    expect(messages[2]).to include(has_media: true, media_status: "unavailable", media_error: "history")
  end

  it "clamps the history limit into 1..200 and defaults garbage to 50" do
    bodies = []
    http = double("http")
    allow(http).to receive(:request) { |req| bodies << JSON.parse(req.body); http_success(body: { "messages" => [] }) }
    allow(Net::HTTP).to receive(:start) { |*_args, **_kwargs, &blk| blk.call(http) }

    adapter.fetch_history(chat_id: "919@c.us", metadata: {})              # default
    adapter.fetch_history(chat_id: "919@c.us", limit: 0, metadata: {})    # below floor
    adapter.fetch_history(chat_id: "919@c.us", limit: 201, metadata: {})  # above cap
    adapter.fetch_history(chat_id: "919@c.us", limit: "120", metadata: {}) # numeric string
    adapter.fetch_history(chat_id: "919@c.us", limit: 75.9, metadata: {}) # float floors
    adapter.fetch_history(chat_id: "919@c.us", limit: "lots", metadata: {}) # garbage
    adapter.fetch_history(chat_id: "919@c.us", limit: nil, metadata: {})  # nil

    expect(bodies.map { |b| b["limit"] }).to eq([50, 1, 200, 120, 75, 50, 50])
  end

  it "raises the standard error when the history fetch fails" do
    allow(Net::HTTP).to receive(:start)
      .and_return(http_failure(code: "422", body: JSON.generate({ error: "`chatId` is required" })))

    expect { adapter.fetch_history(chat_id: "12@g.us", metadata: {}) }
      .to raise_error(/service request failed \(422\)/)
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

  # Net::HTTP does not infer TLS from the URL scheme — an https service URL
  # without use_ssl would send the token and payloads in plaintext.
  it "enables TLS for https service URLs on the JSON request path" do
    secure = described_class.new(base_url: "https://wa.example.com")
    allow(Net::HTTP).to receive(:start).and_return(http_success(body: { "success" => true }))

    secure.logout(metadata: { user_id: "u-1" })

    expect(Net::HTTP).to have_received(:start)
      .with("wa.example.com", 443, hash_including(use_ssl: true))
  end

  it "enables TLS for https service URLs on the binary media path" do
    secure = described_class.new(base_url: "https://wa.example.com")
    allow(Net::HTTP).to receive(:start).and_return(binary_response(code: "404"))

    secure.fetch_media(message_id: "m1", metadata: { user_id: "u-1" })

    expect(Net::HTTP).to have_received(:start)
      .with("wa.example.com", 443, hash_including(use_ssl: true))
  end

  it "keeps TLS off for plain http service URLs on both paths" do
    allow(Net::HTTP).to receive(:start).and_return(
      http_success(body: { "success" => true }), binary_response(code: "404")
    )

    adapter.logout(metadata: {})
    adapter.fetch_media(message_id: "m1", metadata: {})

    expect(Net::HTTP).to have_received(:start)
      .with("127.0.0.1", 3001, hash_including(use_ssl: false)).twice
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
