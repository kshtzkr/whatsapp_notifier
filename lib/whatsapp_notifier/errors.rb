module WhatsAppNotifier
  class Error < StandardError; end
  class ConfigurationError < Error; end
  class DeliveryError < Error; end

  # Raised when the service answers a non-2xx. Carries the HTTP status so
  # callers classify on the status instead of re-parsing the message text.
  #
  # Subclasses RuntimeError, NOT WhatsAppNotifier::Error: before 0.9.0 this
  # was a bare `raise "service request failed (...)"`, so hosts wrote
  # `rescue RuntimeError` around media fetches and status polls. Hanging it
  # off Error instead would silently stop those rescues from firing and turn
  # a handled 5xx into an unhandled one.
  #
  # The message keeps its pre-0.9.0 wording ("service request failed (401):
  # ...") for the same reason — hosts that fingerprinted that string keep
  # matching while they migrate to Result#error_code.
  class ServiceError < RuntimeError
    attr_reader :status

    def initialize(message, status: nil)
      super(message)
      @status = status
    end
  end
end
