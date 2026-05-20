module WhatsAppNotifier
  class SessionsController < ApplicationController
    # GET /status — connection state for the current user
    def show
      data = WhatsAppNotifier.connection_status(metadata: metadata)
      render json: data.merge(hasQR: data[:has_qr])
    rescue StandardError => e
      render json: { error: "Failed to fetch status: #{e.message}" },
             status: :internal_server_error
    end

    # GET /qr — the latest QR for the current user (nil while initializing)
    def qr
      qr_code = WhatsAppNotifier.scan_qr(metadata: metadata)
      if qr_code
        render json: { qr: qr_code }
      else
        render json: { error: "No QR available" }, status: :not_found
      end
    rescue StandardError => e
      render json: { error: "Failed to fetch QR: #{e.message}" },
             status: :internal_server_error
    end

    private

    def metadata
      { user_id: whatsapp_notifier_user_id }
    end
  end
end
