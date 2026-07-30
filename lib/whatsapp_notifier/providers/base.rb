module WhatsAppNotifier
  module Providers
    class Base
      attr_reader :configuration

      def initialize(configuration:)
        @configuration = configuration
      end

      def deliver(_payload)
        raise NotImplementedError, "#{self.class.name} must implement #deliver"
      end

      def scan_qr(metadata: {})
        raise NotImplementedError, "#{self.class.name} does not support QR scanning"
      end

      def connection_status(metadata: {})
        raise NotImplementedError, "#{self.class.name} does not support status checking"
      end

      # True when the paired session can actually send right now. Wraps
      # #connection_status so hosts stop reimplementing the same
      # "authenticated == true, rescue transport errors to false" check — a
      # status endpoint the host cannot reach means sends can't succeed
      # either, so an unreachable service reads as not-ready.
      #
      # ConfigurationError is deliberately NOT swallowed: that is a boot-time
      # mistake in the host, and answering `false` would quietly park every
      # send behind a "session down" backoff instead of surfacing it.
      def session_ready?(metadata: {})
        status = connection_status(metadata: metadata)
        status.is_a?(Hash) && status[:authenticated] == true
      rescue ConfigurationError
        raise
      rescue StandardError => e
        configuration.logger&.warn("[WhatsAppNotifier] session_ready? failed: #{e.message}")
        false
      end
    end
  end
end
