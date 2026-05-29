module WhatsAppNotifier
  module Session
    class QrService
      attr_reader :store, :adapter

      def initialize(store:, adapter:)
        @store = store
        @adapter = adapter
      end

      def qr_code(metadata: {})
        # We don't cache the QR code because it expires every ~20 seconds.
        # The underlying adapter/service provides the latest one each call.
        adapter.fetch_qr_code(metadata: metadata)
      end

      def activate!(token)
        session = store.load
        store.save(session.merge(active: true, token: token, qr_code: nil))
      end
    end
  end
end
