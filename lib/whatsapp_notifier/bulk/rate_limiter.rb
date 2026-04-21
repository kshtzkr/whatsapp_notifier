module WhatsAppNotifier
  module Bulk
    class RateLimiter
      def initialize(base_delay:, jitter:, sleeper:, rng: Random.new)
        @base_delay = base_delay.to_f
        @jitter = jitter.to_f
        @sleeper = sleeper
        @rng = rng
      end

      def wait_before_next
        delay = @base_delay + (@rng.rand * @jitter)
        @sleeper.call(delay) if delay.positive?
      end
    end
  end
end
