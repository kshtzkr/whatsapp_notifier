require "logger"

module WhatsAppNotifier
  class Configuration
    attr_accessor :provider, :official_sender, :web_adapter, :web_session_path,
                  :bulk_base_delay_seconds, :bulk_jitter_seconds, :bulk_max_recipients,
                  :bulk_max_attempts, :bulk_retryable_error_codes, :logger,
                  :web_automation_enabled, :warn_on_risky_provider

    def initialize
      @provider = :official_api
      @official_sender = nil
      @web_adapter = nil
      @web_session_path = "tmp/whatsapp_notifier/session.json"
      @bulk_base_delay_seconds = 1.0
      @bulk_jitter_seconds = 0.3
      @bulk_max_recipients = 500
      @bulk_max_attempts = 3
      @bulk_retryable_error_codes = %i[rate_limited network_error temporary_failure].freeze
      @logger = Logger.new($stdout)
      @web_automation_enabled = false
      @warn_on_risky_provider = true
    end

    def validate!
      raise ConfigurationError, "provider is required" if provider.nil?
      raise ConfigurationError, "bulk_max_recipients must be positive" if bulk_max_recipients.to_i <= 0
      raise ConfigurationError, "bulk_max_attempts must be positive" if bulk_max_attempts.to_i <= 0
    end
  end
end
