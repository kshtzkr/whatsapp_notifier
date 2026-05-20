module WhatsAppNotifier
  class ApplicationController < WhatsAppNotifier.configuration.parent_controller.constantize
    before_action :__whatsapp_notifier_authenticate!

    private

    def __whatsapp_notifier_authenticate!
      hook = WhatsAppNotifier.configuration.authenticate_with
      return unless hook
      instance_exec(&hook)
    end

    def whatsapp_notifier_user_id
      resolver = WhatsAppNotifier.configuration.current_user_id_resolver
      return nil unless resolver
      instance_exec(&resolver)
    end
  end
end
