require_relative "whatsapp_notifier/version"
require_relative "whatsapp_notifier/errors"
require_relative "whatsapp_notifier/result"
require_relative "whatsapp_notifier/configuration"
require_relative "whatsapp_notifier/providers/base"
require_relative "whatsapp_notifier/providers/official_api"
require_relative "whatsapp_notifier/session/store"
require_relative "whatsapp_notifier/session/qr_service"
require_relative "whatsapp_notifier/providers/web_automation"
require_relative "whatsapp_notifier/bulk/rate_limiter"
require_relative "whatsapp_notifier/bulk/retry_policy"
require_relative "whatsapp_notifier/bulk/dispatcher"
require_relative "whatsapp_notifier/client"
require_relative "whatsapp_notifier/jobs/send_message_job"
require_relative "whatsapp_notifier/notification"

module WhatsAppNotifier
  class << self
    def configure
      yield(configuration)
      configuration.validate!
      @client = Client.new(configuration: configuration)
    end

    def configuration
      @configuration ||= Configuration.new
    end

    def reset!
      @configuration = Configuration.new
      @client = Client.new(configuration: @configuration)
    end

    def client
      @client ||= Client.new(configuration: configuration)
    end

    def deliver(to:, body:, metadata: {}, provider: nil, idempotency_key: nil)
      client.deliver(
        to: to,
        body: body,
        metadata: metadata,
        provider: provider,
        idempotency_key: idempotency_key
      )
    end

    def deliver_bulk(messages, provider: nil, sleeper: ->(seconds) { sleep(seconds) }, rng: Random.new)
      client.deliver_bulk(messages, provider: provider, sleeper: sleeper, rng: rng)
    end

    def scan_qr(provider: :web_automation)
      client.scan_qr(provider: provider)
    end
  end
end

# :nocov:
if defined?(Rails::Railtie)
  require_relative "whatsapp_notifier/railtie"
end
# :nocov:
