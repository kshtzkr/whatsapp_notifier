module WhatsAppNotifier
  module Jobs
    class SendMessageJob < ::ActiveJob::Base
      queue_as :default

      def perform(notification_class_name, params)
        klass = notification_class_name.split("::").inject(Object) { |ctx, const| ctx.const_get(const) }
        klass.with(params).deliver_now
      end
    end
  end
end
