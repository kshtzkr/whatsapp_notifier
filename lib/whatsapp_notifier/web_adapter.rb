require "json"
require "net/http"
require "uri"

module WhatsAppNotifier
  class WebAdapter
    DEFAULT_OPEN_TIMEOUT = 5
    DEFAULT_READ_TIMEOUT = 30
    # Media bytes can be tens of MB over a slow link — give the binary fetch a
    # longer read window than the JSON control plane.
    MEDIA_OPEN_TIMEOUT = 5
    MEDIA_READ_TIMEOUT = 60

    HTTP_CLASSES = {
      post: Net::HTTP::Post,
      get: Net::HTTP::Get,
      delete: Net::HTTP::Delete
    }.freeze

    # Optional inbound keys introduced by the 0.7.0 service (media verdict +
    # sender display name) and the 0.8.0 service (two-way capture). Mapped
    # ONLY when the wire payload carries them, so hosts can key-gate on
    # presence: a missing has_media means "0.6.0 service, no media support"
    # (while has_media: false means "text message"), and a missing from_me
    # means "customer message or pre-0.8.0 service". `to` carries the
    # counterparty chat id on operator-sent (from_me) messages — the id the
    # host threads the conversation on.
    INBOUND_OPTIONAL_KEYS = {
      has_media: %w[hasMedia has_media],
      media_status: %w[mediaStatus media_status],
      media_error: %w[mediaError media_error],
      media_mime: %w[mediaMime media_mime],
      media_filename: %w[mediaFilename media_filename],
      media_size: %w[mediaSize media_size],
      sender_name: %w[senderName sender_name],
      to: %w[to],
      from_me: %w[fromMe from_me]
    }.freeze

    def self.default_base_url
      ENV["WHATSAPP_NOTIFIER_SERVICE_URL"] || ENV["WHATSAPP_SERVICE_URL"] || "http://127.0.0.1:3001"
    end

    def initialize(base_url: self.class.default_base_url,
                   open_timeout: DEFAULT_OPEN_TIMEOUT,
                   read_timeout: DEFAULT_READ_TIMEOUT)
      @base_url = base_url
      @open_timeout = open_timeout
      @read_timeout = read_timeout
    end

    def send_message(payload:, session: {})
      user_id = user_id_from(payload[:metadata] || {})
      body = {
        to: payload[:to],
        message: payload[:body],
        mediaUrl: payload.dig(:metadata, :media_url)
      }.compact

      response = request(:post, "/send/#{user_id}", body: body)
      {
        success: response.fetch("success"),
        # Prefer the service-issued WhatsApp message id (0.8.0): it is the key
        # the host dedupes the send's own fromMe echo on, so a real id must
        # win over the locally fabricated one. The fallback keeps 0.7.0
        # services (no messageId in the response) working unchanged.
        message_id: response["messageId"] || response["message_id"] ||
                    payload[:idempotency_key] || "local-#{Time.now.to_i}",
        session: session,
        error_message: response["error"]
      }
    end

    def fetch_qr_code(metadata: {})
      user_id = user_id_from(metadata)
      response = request(:get, "/qr/#{user_id}")
      response["qr"]
    end

    def connection_status(metadata: {})
      user_id = user_id_from(metadata)
      response = request(:get, "/status/#{user_id}")
      {
        state: response["state"],
        authenticated: response["authenticated"],
        has_qr: response["hasQR"]
      }
    end

    # Drains the service's pending inbound queue for this user. The service
    # returns the messages once, then clears them (at-least-once handoff —
    # callers must dedupe on message_id). Accepts either a bare array or a
    # { "messages" => [...] } envelope so the wire format can evolve.
    def fetch_inbound(metadata: {})
      user_id = user_id_from(metadata)
      response = request(:get, "/inbound/#{user_id}")
      raw = response.is_a?(Hash) ? response["messages"] : response
      Array(raw).map { |m| map_inbound_message(m) }
    end

    # Fetches the raw bytes of a downloaded inbound media file. Returns
    # { body:, mime:, filename:, size: } or nil when the service has no copy
    # (never downloaded, swept by TTL, or already deleted).
    #
    # Deliberately NOT routed through #request: that path JSON-parses the
    # response body (and host apps are known to patch it further), which would
    # corrupt binary payloads.
    def fetch_media(message_id:, metadata: {})
      user_id = user_id_from(metadata)
      res = binary_get("/media/#{user_id}/#{path_id(message_id)}")
      return nil if res.code.to_s == "404"
      raise "service request failed (#{res.code}): #{res.body}" unless res.is_a?(Net::HTTPSuccess)

      body = res.body.to_s
      {
        body: body,
        mime: res["Content-Type"],
        filename: filename_from(res["Content-Disposition"]),
        size: body.bytesize
      }
    end

    # On-demand re-download (WhatsApp tap-to-download). The host calls this when
    # an operator opens a media bubble whose bytes the service no longer holds
    # (rolled off by the per-user cap or expired by TTL): the service re-pulls
    # THAT one message's media and stores it, after which the host fetches it
    # with the usual fetch_media GET. Returns { mime:, filename:, size:, status: }
    # on success, or nil when the media is gone upstream (404) — same nil-on-404
    # contract as fetch_media, so a host that gets nil can grey the bubble out.
    # A 0.7.0 service mid-rollout has no /refetch route and also answers 404 →
    # nil, indistinguishable from gone, which is the safe degrade.
    def refetch_media(message_id:, chat_id:, metadata: {})
      user_id = user_id_from(metadata)
      body = { messageId: message_id, chatId: chat_id }
      response = request(:post, "/media/#{user_id}/refetch", body: body, allow_404: true)
      return nil unless response["success"]

      {
        mime: response["mediaMime"] || response["media_mime"],
        filename: response["mediaFilename"] || response["media_filename"],
        size: response["mediaSize"] || response["media_size"],
        status: response["mediaStatus"] || response["media_status"]
      }
    end

    # Removes the service's copy after the host has attached the bytes.
    # Idempotent on the service side: deleting absent media still succeeds.
    # A 0.6.0 service mid-rollout has no /media routes and answers 404 —
    # degrade to { success: false } instead of raising, mirroring
    # fetch_media's nil-on-404.
    def delete_media(message_id:, metadata: {})
      user_id = user_id_from(metadata)
      response = request(:delete, "/media/#{user_id}/#{path_id(message_id)}", allow_404: true)
      { success: response.fetch("success", false) }
    end

    # Lists the paired number's 1:1 chats for history-sync discovery. Returns
    # [{ id:, name:, last_message_at: }] newest-first; the service caps the
    # list at its newest 500 and excludes groups/status/privacy chats. The
    # route is token-gated like /media and raises the standard error on any
    # non-2xx (401 when the user never paired or isn't ready).
    def list_chats(metadata: {})
      user_id = user_id_from(metadata)
      response = request(:get, "/chats/#{user_id}")
      Array(response["chats"]).map { |chat| map_chat_summary(chat) }
    end

    # Replays one chat's history through the service's live-capture
    # normalizer and returns it synchronously (no queue, no webhook) —
    # oldest-first, mapped exactly like fetch_inbound messages, including
    # from_me/to on the operator's side of the conversation. History media
    # arrives marked unavailable by design (media_error "history"): the
    # service never bulk-downloads old media; live capture handles bytes
    # going forward.
    def fetch_history(chat_id:, limit: 50, metadata: {})
      user_id = user_id_from(metadata)
      body = { chatId: chat_id, limit: clamp_history_limit(limit) }
      response = request(:post, "/history/#{user_id}", body: body)
      Array(response["messages"]).map { |m| map_inbound_message(m) }
    end

    # Logs the user out of WhatsApp and clears their saved session on the service.
    def logout(metadata: {})
      user_id = user_id_from(metadata)
      response = request(:post, "/logout/#{user_id}")
      { success: response.fetch("success", false) }
    end

    # Mirrors the service-side clamp (history.ts) so a host-passed limit can
    # never balloon one request into a session-stalling bulk fetch.
    HISTORY_LIMIT_DEFAULT = 50
    HISTORY_LIMIT_RANGE = (1..200).freeze

    private

    def user_id_from(metadata)
      (metadata[:user_id] || metadata["user_id"] || "default").to_s
    end

    def clamp_history_limit(limit)
      Integer(limit).clamp(HISTORY_LIMIT_RANGE.min, HISTORY_LIMIT_RANGE.max)
    rescue ArgumentError, TypeError
      # Non-integer garbage falls back to the default — the service does the
      # same, so both layers agree on the effective page size.
      HISTORY_LIMIT_DEFAULT
    end

    def map_chat_summary(chat)
      {
        id: chat["id"],
        name: chat["name"],
        last_message_at: chat.key?("lastMessageAt") ? chat["lastMessageAt"] : chat["last_message_at"]
      }
    end

    def map_inbound_message(message)
      mapped = {
        from: message["from"],
        body: message["body"],
        message_id: message["messageId"] || message["message_id"],
        timestamp: message["timestamp"],
        type: message["type"]
      }
      INBOUND_OPTIONAL_KEYS.each do |key, wire_keys|
        wire = wire_keys.find { |candidate| message.key?(candidate) }
        mapped[key] = message[wire] if wire
      end
      mapped
    end

    # Mirror the service-side sanitizeId charset so a hostile message_id can
    # never smuggle path separators or a query string into the request URL.
    def path_id(message_id)
      message_id.to_s.gsub(/[^A-Za-z0-9@._-]/, "")
    end

    def filename_from(content_disposition)
      content_disposition.to_s[/filename="([^"]*)"/, 1]
    end

    # The /media routes are token-gated when the service has
    # WHATSAPP_WEBHOOK_TOKEN set — the same shared secret the service uses to
    # sign its webhook pushes, reused in the other direction.
    def webhook_token
      token = ENV["WHATSAPP_WEBHOOK_TOKEN"].to_s
      token.empty? ? nil : token
    end

    # Net::HTTP does NOT infer TLS from the URL scheme — without an explicit
    # use_ssl a https:// service URL would silently speak plaintext to port
    # 443. Both request paths (JSON control plane + binary media fetch) must
    # honor the scheme.
    def use_ssl?(uri)
      uri.scheme == "https"
    end

    def binary_get(path)
      uri = URI.parse("#{@base_url}#{path}")
      req = Net::HTTP::Get.new(uri.request_uri)
      req["X-WA-Token"] = webhook_token if webhook_token

      Net::HTTP.start(uri.host, uri.port,
                      use_ssl: use_ssl?(uri),
                      open_timeout: MEDIA_OPEN_TIMEOUT,
                      read_timeout: MEDIA_READ_TIMEOUT) { |http| http.request(req) }
    end

    def request(method, path, body: nil, allow_404: false)
      uri = URI.parse("#{@base_url}#{path}")
      req = HTTP_CLASSES.fetch(method).new(uri.request_uri)
      req["Content-Type"] = "application/json"
      req["X-WA-Token"] = webhook_token if webhook_token
      req.body = JSON.generate(body) if body

      res = Net::HTTP.start(uri.host, uri.port,
                            use_ssl: use_ssl?(uri),
                            open_timeout: @open_timeout,
                            read_timeout: @read_timeout) { |http| http.request(req) }
      parsed = parse_body(res.body)
      return parsed if res.is_a?(Net::HTTPSuccess)
      # Callers opting in treat "route/resource not there" as a soft miss
      # (e.g. delete_media against a 0.6.0 service) — the parsed error body
      # carries no "success" key, so they degrade rather than raise.
      return parsed if allow_404 && res.code.to_s == "404"

      raise "service request failed (#{res.code}): #{parsed["error"] || res.body}"
    end

    def parse_body(raw)
      return {} if raw.to_s.strip.empty?

      JSON.parse(raw)
    rescue JSON::ParserError
      { "error" => raw }
    end
  end
end
