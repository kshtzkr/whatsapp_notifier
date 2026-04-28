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

    end
  end
end
