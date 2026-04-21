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

      def scan_qr
        raise NotImplementedError, "#{self.class.name} does not support QR scanning"
      end
    end
  end
end
