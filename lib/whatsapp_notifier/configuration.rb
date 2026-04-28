require "logger"

module WhatsAppNotifier
  class Configuration
    attr_accessor :provider, :web_adapter, :web_session_path,
                  :bulk_base_delay_seconds, :bulk_jitter_seconds, :bulk_max_recipients,
                  :bulk_max_attempts, :bulk_retryable_error_codes, :logger,
                  :web_automation_enabled, :warn_on_risky_provider

    def initialize
      @provider = :web_automation
      @web_adapter = WebAdapter.new
      @web_session_path = "tmp/whatsapp_notifier/session.json"
      @bulk_base_delay_seconds = 1.0
      @bulk_jitter_seconds = 0.3
      @bulk_max_recipients = 500
      @bulk_max_attempts = 3
      @bulk_retryable_error_codes = %i[rate_limited network_error temporary_failure].freeze
      @logger = Logger.new($stdout)
      @web_automation_enabled = true
      @warn_on_risky_provider = true
    end

    def validate!
      raise ConfigurationError, "provider is required" if provider.nil?
      raise ConfigurationError, "only :web_automation provider is supported" unless provider.to_sym == :web_automation
      raise ConfigurationError, "bulk_max_recipients must be positive" if bulk_max_recipients.to_i <= 0
      raise ConfigurationError, "bulk_max_attempts must be positive" if bulk_max_attempts.to_i <= 0
      raise ConfigurationError, "web_adapter must be configured and respond to send_message, fetch_qr_code, connection_status" unless valid_web_adapter?
    end

    private

    def valid_web_adapter?
      return false unless web_adapter

      required_methods = %i[send_message fetch_qr_code connection_status]
      required_methods.all? { |method_name| web_adapter.respond_to?(method_name) }
    end
  end
end
