module WhatsAppNotifier
  module Providers
    class WebAutomation < Base
      def initialize(configuration:)
        super
        @store = Session::Store.new(path: configuration.web_session_path)
      end

      def deliver(payload)
        raise ConfigurationError, "web automation provider is disabled" unless configuration.web_automation_enabled

        adapter = configuration.web_adapter
        raise ConfigurationError, "web_adapter must be configured for web_automation provider" unless adapter.respond_to?(:send_message)

        warn_risk_once
        response = adapter.send_message(payload: payload, session: @store.load)
        @store.save(response.fetch(:session, {}))

        Result.new(
          success: response.fetch(:success),
          provider: :web_automation,
          message_id: response[:message_id],
          error_code: response[:error_code],
          error_message: response[:error_message],
          wait_seconds: response[:wait_seconds],
          metadata: response.fetch(:metadata, {})
        )
      rescue StandardError => e
        Result.new(success: false, provider: :web_automation, error_code: :delivery_exception, error_message: e.message)
      end

      def scan_qr
        raise ConfigurationError, "web automation provider is disabled" unless configuration.web_automation_enabled

        adapter = configuration.web_adapter
        raise ConfigurationError, "web_adapter must be configured for web_automation provider" unless adapter.respond_to?(:fetch_qr_code)

        Session::QrService.new(store: @store, adapter: adapter).qr_code
      end

      private

      def warn_risk_once
        return unless configuration.warn_on_risky_provider
        return if defined?(@risk_warned) && @risk_warned

        configuration.logger.warn("web_automation provider is experimental and may violate WhatsApp terms; prefer official_api in production.")
        @risk_warned = true
      end
    end
  end
end
