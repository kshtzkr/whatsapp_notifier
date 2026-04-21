module WhatsAppNotifier
  module Session
    class QrService
      attr_reader :store, :adapter

      def initialize(store:, adapter:)
        @store = store
        @adapter = adapter
      end

      def qr_code
        session = store.load
        return session[:qr_code] if session[:qr_code]

        generated = adapter.fetch_qr_code
        store.save(session.merge(qr_code: generated))
        generated
      end

      def activate!(token)
        session = store.load
        store.save(session.merge(active: true, token: token, qr_code: nil))
      end
    end
  end
end
