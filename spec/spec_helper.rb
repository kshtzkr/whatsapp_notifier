require "simplecov"

SimpleCov.start do
  add_filter "/spec/"
  minimum_coverage 100
end

require "whatsapp_notifier"
require "tmpdir"

RSpec.configure do |config|
  config.order = :random

  config.before do
    WhatsAppNotifier.reset!
  end
end
