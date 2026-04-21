require "spec_helper"

class JobNotification < WhatsAppNotifier::Notification
  def message
    "job message"
  end
end

RSpec.describe WhatsAppNotifier::Jobs::SendMessageJob do
  before do
    WhatsAppNotifier.configure do |config|
      config.official_sender = ->(_payload) { { success: true } }
    end
  end

  it "performs now by resolving class name" do
    result = described_class.perform_now("JobNotification", to: "+1")
    expect(result).to be_success
  end

  it "raises when perform_later has no active job base" do
    hide_const("ActiveJob")
    expect { described_class.perform_later("JobNotification", to: "+1") }.to raise_error(LoadError)
  end

  it "allows perform_later when active job base is present" do
    stub_const("ActiveJob::Base", Class.new)
    expect { described_class.perform_later("JobNotification", to: "+1") }.not_to raise_error
  end
end
