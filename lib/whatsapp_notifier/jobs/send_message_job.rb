module WhatsAppNotifier
  module Jobs
    class SendMessageJob
      def self.perform_later(notification_class_name, params)
        raise LoadError, "ActiveJob is required for deliver_later" unless defined?(::ActiveJob::Base)

        perform_now(notification_class_name, params)
      end

      def self.perform_now(notification_class_name, params)
        new.perform(notification_class_name, params)
      end

      def perform(notification_class_name, params)
        klass = notification_class_name.split("::").inject(Object) { |ctx, const| ctx.const_get(const) }
        klass.with(params).deliver_now
      end
    end
  end
end
