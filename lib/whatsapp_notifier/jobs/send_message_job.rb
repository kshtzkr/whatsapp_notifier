module WhatsAppNotifier
  module Jobs
    if defined?(::ActiveJob::Base)
      # Real async path, only live in a host app that has ActiveJob loaded (any
      # Rails app). Not exercisable in the gem's unit suite — the class is chosen
      # at load time and ActiveJob isn't a gem dependency.
      # :nocov:
      class SendMessageJob < ::ActiveJob::Base
        queue_as :default

        def perform(notification_class_name, params)
          klass = notification_class_name.split("::").inject(Object) { |ctx, const| ctx.const_get(const) }
          klass.with(params).deliver_now
        end
      end
      # :nocov:
    else
      class SendMessageJob
        def self.perform_later(notification_class_name, params)
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
end
