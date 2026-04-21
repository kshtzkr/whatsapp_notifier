module WhatsAppNotifier
  class Result
    attr_reader :success, :provider, :message_id, :error_code, :error_message, :wait_seconds, :metadata

    def initialize(success:, provider:, message_id: nil, error_code: nil, error_message: nil, wait_seconds: nil, metadata: {})
      @success = success
      @provider = provider
      @message_id = message_id
      @error_code = error_code
      @error_message = error_message
      @wait_seconds = wait_seconds
      @metadata = metadata
    end

    def success?
      success
    end

    def failure?
      !success?
    end
  end
end
