module WhatsAppNotifier
  class MessagesController < ApplicationController
    # API endpoint: Hotwire / Stimulus calls send the Rails CSRF token in
    # X-CSRF-Token automatically; allow callers without an authentic
    # token by giving them a fresh session instead of a 422.
    skip_before_action :verify_authenticity_token, raise: false

    # POST /send — single-recipient send for the current user
    def create
      to        = params[:to] || params[:phone] or
                  raise ActionController::ParameterMissing, "to (or phone)"
      message   = params.require(:message)
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
