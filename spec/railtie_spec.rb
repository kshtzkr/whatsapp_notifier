require "spec_helper"

RSpec.describe "WhatsAppNotifier::Railtie" do
  it "applies app config values to gem configuration" do
    Object.send(:remove_const, :Rails) if defined?(Rails)
    WhatsAppNotifier.send(:remove_const, :Railtie) if defined?(WhatsAppNotifier::Railtie)

    stub_const("Rails", Module.new)

    railtie_base = Class.new do
      class << self
        attr_accessor :captured_initializer
      end

      def self.config
        @config ||= Struct.new(:whatsapp_notifier).new({})
      end

      def self.initializer(_name, &block)
        self.captured_initializer = block
      end
    end
    stub_const("Rails::Railtie", railtie_base)

    load File.expand_path("../lib/whatsapp_notifier/railtie.rb", __dir__)

    app_config = {
      web_automation_enabled: true,
      bulk_max_attempts: 5
    }
    app = Struct.new(:config).new(Struct.new(:whatsapp_notifier).new(app_config))
    WhatsAppNotifier::Railtie.captured_initializer.call(app)

    expect(WhatsAppNotifier.configuration.web_automation_enabled).to be(true)
    expect(WhatsAppNotifier.configuration.bulk_max_attempts).to eq(5)
  end
end
