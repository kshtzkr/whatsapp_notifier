module WhatsAppNotifier
  class Notification
    class << self
      attr_accessor :default_to, :default_provider, :default_template

      def with(params = {})
        new(params)
      end

      def to(value = nil)
        return default_to if value.nil?
        self.default_to = value
      end

      def provider(value = nil)
        return default_provider if value.nil?
        self.default_provider = value
      end

      def template(name = nil, body = nil)
        @templates ||= {}
        return default_template if name.nil?

        self.default_template = name.to_sym
        @templates[name.to_sym] = body if body
      end

      def templates
        @templates ||= {}
      end

      def deliver_now(params = {})
        with(params).deliver_now
      end

      def deliver_later(params = {})
        Jobs::SendMessageJob.perform_later(name, params)
      end
    end

    attr_reader :params

    def initialize(params = {})
      @params = params
    end

    def message
      return render_template if template_name

      raise NotImplementedError, "#{self.class.name} must implement #message or define template"
    end

    def to
      params[:to] || self.class.default_to
    end

    def provider
      params[:provider] || self.class.default_provider
    end

    def metadata
      params[:metadata] || {}
    end

    def template_name
      (params[:template] || self.class.default_template)&.to_sym
    end

    def template_params
      params[:params] || {}
    end

    def deliver_now
      raise ConfigurationError, "recipient is required" if to.nil? || to.to_s.strip.empty?

      WhatsAppNotifier.deliver(
        to: to,
        body: message,
        provider: provider,
        metadata: metadata
      )
    end

    private

    def render_template
      body = self.class.templates[template_name]
      raise ConfigurationError, "template not found: #{template_name}" unless body

      body.gsub(/\{\{(\w+)\}\}/) { |_match| template_params[Regexp.last_match(1).to_sym].to_s }
    end
  end
end
