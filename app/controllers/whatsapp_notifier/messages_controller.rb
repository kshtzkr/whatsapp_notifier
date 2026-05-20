module WhatsAppNotifier
  class MessagesController < ApplicationController
    # POST /send — single-recipient send for the current user
    def create
      to       = params.require(:to)
      message  = params.require(:message)
      media_url = params[:media_url]

      result = WhatsAppNotifier.deliver(
        to:       to,
        body:     message,
        metadata: { user_id: whatsapp_notifier_user_id, media_url: media_url }
      )

      if result.success?
        render json: { success: true, message_id: result.message_id }
      else
        render json: { success: false, error: result.error_message },
               status: :unprocessable_entity
      end
    rescue ActionController::ParameterMissing => e
      render json: { success: false, error: e.message }, status: :bad_request
    rescue StandardError => e
      render json: { success: false, error: e.message },
             status: :internal_server_error
    end
  end
end
