module WhatsAppNotifier
  class Client
    def initialize(configuration:)
      @configuration = configuration
      @providers = {}
    end

    def deliver(to:, body:, metadata: {}, provider: nil, idempotency_key: nil)
      payload = {
        to: to,
        body: body,
        metadata: metadata,
        idempotency_key: idempotency_key
      }
      provider_for(provider || @configuration.provider).deliver(payload)
    end

    def deliver_bulk(messages, provider: nil, sleeper: ->(seconds) { sleep(seconds) }, rng: Random.new)
      Bulk::Dispatcher.new(client: self, configuration: @configuration, sleeper: sleeper, rng: rng).deliver(messages, provider: provider)
    end

    def scan_qr(provider: nil)
      provider_for(provider || @configuration.provider).scan_qr
    end

    private

    def provider_for(key)
      @providers[key] ||= build_provider(key)
    end

    def build_provider(key)
      case key.to_sym
      when :official_api
        Providers::OfficialApi.new(configuration: @configuration)
      when :web_automation
        Providers::WebAutomation.new(configuration: @configuration)
      else
        raise ConfigurationError, "unknown provider: #{key.inspect}"
      end
    end
  end
end
