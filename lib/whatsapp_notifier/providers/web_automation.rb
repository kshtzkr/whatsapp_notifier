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
        session = session_for(payload.fetch(:metadata, {}))
        response = adapter.send_message(payload: payload, session: session)
        persist_session(response.fetch(:session, {}), payload.fetch(:metadata, {}))

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

      def scan_qr(metadata: {})
        raise ConfigurationError, "web automation provider is disabled" unless configuration.web_automation_enabled

        adapter = configuration.web_adapter
        raise ConfigurationError, "web_adapter must be configured for web_automation provider" unless adapter.respond_to?(:fetch_qr_code)

        Session::QrService.new(store: @store, adapter: adapter).qr_code(metadata: metadata)
      end

      def connection_status(metadata: {})
        raise ConfigurationError, "web automation provider is disabled" unless configuration.web_automation_enabled

        adapter = configuration.web_adapter
        raise ConfigurationError, "web_adapter must be configured for web_automation provider" unless adapter.respond_to?(:connection_status)

        adapter.connection_status(metadata: metadata)
      end


      private

      def session_for(metadata)
        user_id = metadata[:user_id]
        return @store.load unless user_id

        all_sessions = @store.load
        all_sessions.fetch(:users, {}).fetch(user_key(user_id), {})
      end

      def persist_session(next_session, metadata)
        user_id = metadata[:user_id]
        return @store.save(next_session) unless user_id

        all_sessions = @store.load
        users = all_sessions.fetch(:users, {})
        users[user_key(user_id)] = next_session
        @store.save(all_sessions.merge(users: users))
      end

      def user_key(user_id)
        user_id.to_s.to_sym
      end

      def warn_risk_once
        return unless configuration.warn_on_risky_provider
        return if defined?(@risk_warned) && @risk_warned

        configuration.logger.warn("web_automation provider uses WhatsApp Web automation. Use responsibly and follow WhatsApp policies.")
        @risk_warned = true
      end
    end
  end
end
