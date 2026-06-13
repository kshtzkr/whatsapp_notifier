require_relative "whatsapp_notifier/version"
require_relative "whatsapp_notifier/errors"
require_relative "whatsapp_notifier/result"
require_relative "whatsapp_notifier/configuration"
require_relative "whatsapp_notifier/web_adapter"
require_relative "whatsapp_notifier/providers/base"
require_relative "whatsapp_notifier/session/store"
require_relative "whatsapp_notifier/session/qr_service"
require_relative "whatsapp_notifier/providers/web_automation"
require_relative "whatsapp_notifier/doctor"
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

    def service_path
      File.expand_path("whatsapp_notifier/services/web_automation", __dir__)
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

    def scan_qr(provider: nil, metadata: {})
      client.scan_qr(provider: provider, metadata: metadata)
    end

    def connection_status(provider: nil, metadata: {})
      client.connection_status(provider: provider, metadata: metadata)
    end

    def fetch_inbound(provider: nil, metadata: {})
      client.fetch_inbound(provider: provider, metadata: metadata)
    end

    def fetch_media(message_id:, provider: nil, metadata: {})
      client.fetch_media(message_id: message_id, provider: provider, metadata: metadata)
    end

    def delete_media(message_id:, provider: nil, metadata: {})
      client.delete_media(message_id: message_id, provider: provider, metadata: metadata)
    end

    def refetch_media(message_id:, chat_id:, provider: nil, metadata: {})
      client.refetch_media(message_id: message_id, chat_id: chat_id, provider: provider, metadata: metadata)
    end

    def list_chats(provider: nil, metadata: {})
      client.list_chats(provider: provider, metadata: metadata)
    end

    def fetch_history(chat_id:, limit: 50, provider: nil, metadata: {})
      client.fetch_history(chat_id: chat_id, limit: limit, provider: provider, metadata: metadata)
    end

    def logout(provider: nil, metadata: {})
      client.logout(provider: provider, metadata: metadata)
    end

  end
end

# :nocov:
if defined?(Rails::Engine)
  require_relative "whatsapp_notifier/engine"
elsif defined?(Rails::Railtie)
  require_relative "whatsapp_notifier/railtie"
end
# :nocov:
