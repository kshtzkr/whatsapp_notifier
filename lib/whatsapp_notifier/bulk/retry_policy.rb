module WhatsAppNotifier
  module Bulk
    class RetryPolicy
      def initialize(max_attempts:, retryable_error_codes:)
        @max_attempts = max_attempts
        @retryable_error_codes = retryable_error_codes
      end

      def with_retries
        attempts = 0
        result = nil

        loop do
          attempts += 1
          result = yield(attempts)
          break unless retry?(result, attempts)
        end

        result
      end

      private

      def retry?(result, attempts)
        return false if attempts >= @max_attempts
        return false if result.success?

        @retryable_error_codes.include?(result.error_code)
      end
    end
  end
end
