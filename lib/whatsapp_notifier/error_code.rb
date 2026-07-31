module WhatsAppNotifier
  # Stable, machine-readable classification of a failed send.
  #
  # Before 0.9.0 every send failure surfaced as error_code :delivery_exception,
  # so hosts had to fingerprint Result#error_message text to decide whether a
  # retry was safe. These codes replace that. They are part of the public API
  # and will not be renamed:
  #
  #   :auth_required        session logged out / service refused upfront —
  #                         nothing was sent
  #   :not_on_whatsapp      the number has no WhatsApp account
  #   :invalid_phone        the number is malformed
  #   :recipient_unresolved the service could not resolve the recipient id
  #                         (wedged session) — nothing was sent
  #   :service_unreachable  the TCP connection never opened — nothing was sent
  #   :timeout              the request went out but the answer never came, so
  #                         the outcome is UNKNOWN — a retry may double-send
  #   :rate_limited         the service throttled the send
  #   :delivery_exception   unclassified; the pre-0.9.0 catch-all, kept as the
  #                         fallback so hosts keying on it keep working
  #
  # The first four plus :service_unreachable are "definitely not sent"; only
  # :timeout and :delivery_exception leave the outcome ambiguous.
  module ErrorCode
    UNCLASSIFIED = :delivery_exception

    ALL = %i[
      auth_required
      not_on_whatsapp
      invalid_phone
      recipient_unresolved
      service_unreachable
      timeout
      rate_limited
      delivery_exception
    ].freeze

    # HTTP status → code, for a non-2xx answer from the service. Checked
    # first: a status is exact where the body text is a guess. 422 is
    # deliberately absent — the service 422s a malformed REQUEST (a host bug),
    # not a bad number, so it falls through to the unclassified catch-all.
    STATUS_CODES = {
      401 => :auth_required,
      403 => :auth_required,
      429 => :rate_limited
    }.freeze

    # Exception class name → code. Matched on the name rather than the
    # constant so this file never has to require net/http or resolve Errno.
    EXCEPTION_CODES = {
      "Errno::ECONNREFUSED" => :service_unreachable,
      "Errno::ECONNRESET" => :service_unreachable,
      "Errno::EHOSTUNREACH" => :service_unreachable,
      "Errno::ENETUNREACH" => :service_unreachable,
      "SocketError" => :service_unreachable,
      "Net::OpenTimeout" => :service_unreachable,
      "Net::ReadTimeout" => :timeout,
      "Net::WriteTimeout" => :timeout,
      "Timeout::Error" => :timeout
    }.freeze

    # Codes a service (or a third-party adapter) may hand us directly, folded
    # into the vocabulary above. Several spellings map to one code because the
    # Bun service has renamed its own codes across versions.
    SERVICE_CODES = {
      "auth_required" => :auth_required,
      "unauthenticated" => :auth_required,
      "unauthorized" => :auth_required,
      "session_expired" => :auth_required,
      "not_on_whatsapp" => :not_on_whatsapp,
      "number_not_on_whatsapp" => :not_on_whatsapp,
      "number_not_registered" => :not_on_whatsapp,
      "invalid_phone" => :invalid_phone,
      "invalid_number" => :invalid_phone,
      "recipient_unresolved" => :recipient_unresolved,
      "service_unreachable" => :service_unreachable,
      "timeout" => :timeout,
      "rate_limited" => :rate_limited,
      "throttled" => :rate_limited
    }.freeze

    # Free-text fingerprints, the last resort: whatsapp-web.js failures reach
    # us as an opaque 500 whose body is the library's own message, so text is
    # all there is. Order matters — the first match wins.
    MESSAGE_CODES = [
      [/\bno lid\b/i, :recipient_unresolved],
      [/not registered|not on whatsapp|not a valid whatsapp/i, :not_on_whatsapp],
      [/invalid wid|wid error|invalid (phone|number)/i, :invalid_phone],
      [/not authenticated|pair via qr|logged out|session expired|unauthorized/i, :auth_required],
      [/connection refused|failed to open tcp|network is unreachable|no route to host/i, :service_unreachable],
      [/execution expired|timed out|timeout/i, :timeout],
      [/rate limit|too many requests/i, :rate_limited]
    ].freeze

    # Bound on what a service-supplied code may look like before we pass it
    # through unrecognized: an identifier, not arbitrary text.
    CODE_SHAPE = /\A[a-z0-9_]{1,64}\z/

    class << self
      # Classify the exception a transport raised. ServiceError carries the
      # HTTP status, which beats guessing from the message.
      def from_exception(exception)
        status_code = status_code_for(exception)
        return status_code if status_code

        EXCEPTION_CODES[exception.class.name] || from_message(exception.message)
      end

      # Classify a failure the transport reported without raising (a 200 body
      # with success: false).
      def from_message(text)
        haystack = text.to_s
        MESSAGE_CODES.each { |pattern, code| return code if pattern.match?(haystack) }
        UNCLASSIFIED
      end

      # Fold a code the service supplied into the vocabulary. Returns nil for
      # a blank code so callers can fall back to their own classification;
      # an unrecognized but identifier-shaped code passes through so a newer
      # service can introduce one without a gem release.
      def normalize(value)
        text = value.to_s.strip.downcase
        return nil if text.empty?

        SERVICE_CODES[text] || (CODE_SHAPE.match?(text) ? text.to_sym : UNCLASSIFIED)
      end

      private

      def status_code_for(exception)
        return nil unless exception.respond_to?(:status)

        STATUS_CODES[exception.status.to_i]
      end
    end
  end
end
