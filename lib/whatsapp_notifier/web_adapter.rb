require "json"
require "net/http"
require "uri"

module WhatsAppNotifier
  class WebAdapter
    def initialize(base_url: ENV.fetch("WHATSAPP_NOTIFIER_SERVICE_URL", "http://127.0.0.1:3001"))
      @base_url = base_url
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
        message_id: payload[:idempotency_key] || "local-#{Time.now.to_i}",
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

    private

    def user_id_from(metadata)
      (metadata[:user_id] || metadata["user_id"] || "default").to_s
    end

    def request(method, path, body: nil)
      uri = URI.parse("#{@base_url}#{path}")
      klass = method == :post ? Net::HTTP::Post : Net::HTTP::Get
      req = klass.new(uri.request_uri)
      req["Content-Type"] = "application/json"
      req.body = JSON.generate(body) if body

      res = Net::HTTP.start(uri.host, uri.port) { |http| http.request(req) }
      parsed = parse_body(res.body)
      return parsed if res.is_a?(Net::HTTPSuccess)

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
