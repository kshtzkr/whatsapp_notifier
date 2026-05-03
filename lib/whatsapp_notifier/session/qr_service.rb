module WhatsAppNotifier
  module Session
    class QrService
      attr_reader :store, :adapter

      def initialize(store:, adapter:)
        @store = store
        @adapter = adapter
      end

      def qr_code(metadata: {})
        generated = adapter.fetch_qr_code(metadata: metadata)
        # We don't cache the QR code because it expires every ~20 seconds
        # The underlying adapter/service is responsible for providing the latest one
        generated
      end


      def activate!(token)
        session = store.load
        store.save(session.merge(active: true, token: token, qr_code: nil))
      end

      private

      def cached_qr(session, user_id)
        return session[:qr_code] unless user_id

        session.fetch(:users, {}).fetch(user_key(user_id), {})[:qr_code]
      end

      def with_cached_qr(session, user_id, qr_code)
        return session.merge(qr_code: qr_code) unless user_id

        users = session.fetch(:users, {})
        key = user_key(user_id)
        user_session = users.fetch(key, {})
        users[key] = user_session.merge(qr_code: qr_code)
        session.merge(users: users)
      end

      def user_key(user_id)
        user_id.to_s.to_sym
      end
    end
  end
end
