module WhatsAppNotifier
  module Providers
    class OfficialApi < Base
      def deliver(payload)
        sender = configuration.official_sender
        raise ConfigurationError, "official_sender must be configured for official_api provider" unless sender.respond_to?(:call)

        response = sender.call(payload)
        normalized = normalize_response(response)

        Result.new(
          success: normalized.fetch(:success),
          provider: :official_api,
          message_id: normalized[:message_id],
          error_code: normalized[:error_code],
          error_message: normalized[:error_message],
          wait_seconds: normalized[:wait_seconds],
          metadata: normalized.fetch(:metadata, {})
        )
      rescue StandardError => e
        Result.new(success: false, provider: :official_api, error_code: :delivery_exception, error_message: e.message)
      end

      private

      def normalize_response(response)
        return response if response.is_a?(Hash)
        { success: !!response }
      end
    end
  end
end
