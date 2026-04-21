require "json"
require "fileutils"

module WhatsAppNotifier
  module Session
    class Store
      def initialize(path:)
        @path = path
      end

      def load
        return {} unless File.exist?(@path)
        JSON.parse(File.read(@path), symbolize_names: true)
      end

      def save(data)
        FileUtils.mkdir_p(File.dirname(@path))
        File.write(@path, JSON.generate(data))
      end
    end
  end
end
