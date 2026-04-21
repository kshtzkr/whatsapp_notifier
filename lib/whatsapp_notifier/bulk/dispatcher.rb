require "set"

module WhatsAppNotifier
  module Bulk
    class Dispatcher
      def initialize(client:, configuration:, sleeper: ->(seconds) { sleep(seconds) }, rng: Random.new)
        @client = client
        @configuration = configuration
        @rate_limiter = RateLimiter.new(
          base_delay: configuration.bulk_base_delay_seconds,
          jitter: configuration.bulk_jitter_seconds,
          sleeper: sleeper,
          rng: rng
        )
        @retry_policy = RetryPolicy.new(
          max_attempts: configuration.bulk_max_attempts,
          retryable_error_codes: configuration.bulk_retryable_error_codes
        )
        @sleeper = sleeper
      end

      def deliver(messages, provider: nil)
        raise ConfigurationError, "messages must be an array" unless messages.is_a?(Array)
        raise ConfigurationError, "bulk_max_recipients exceeded" if messages.length > @configuration.bulk_max_recipients

        sent_keys = Set.new
        results = messages.map.with_index do |message, idx|
          @rate_limiter.wait_before_next if idx.positive?
          deliver_one(message, sent_keys: sent_keys, provider: provider)
        end

        { total: results.length, success: results.count(&:success?), failed: results.count(&:failure?), results: results }
      end

      private

      def deliver_one(message, sent_keys:, provider:)
        idempotency_key = message[:idempotency_key]
        if idempotency_key && sent_keys.include?(idempotency_key)
          return Result.new(
            success: false,
            provider: provider || @configuration.provider,
            error_code: :duplicate_idempotency_key,
            error_message: "idempotency key already processed"
          )
        end

        result = @retry_policy.with_retries do |_attempt|
          @client.deliver(
            to: message.fetch(:to),
            body: message.fetch(:body),
            metadata: message.fetch(:metadata, {}),
            provider: provider,
            idempotency_key: idempotency_key
          )
        end

        @sleeper.call(result.wait_seconds) if result.wait_seconds.to_f.positive?
        sent_keys << idempotency_key if idempotency_key && result.success?
        result
      end
    end
  end
end
