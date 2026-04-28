require "spec_helper"

class TestNotification < WhatsAppNotifier::Notification
  template :hello, "Hi {{name}}"
  to "+100"
  provider :web_automation
end

class ExplicitMessageNotification < WhatsAppNotifier::Notification
  def message
    "direct-body"
  end
end

RSpec.describe WhatsAppNotifier::Notification do
  before do
    WhatsAppNotifier.configure do |config|
      config.provider = :web_automation
      config.web_automation_enabled = true
      config.web_adapter = double(
        send_message: { success: true, metadata: {}, session: {} },
        fetch_qr_code: "qr",
        connection_status: { state: "AUTHENTICATED", authenticated: true }
      )
    end
  end

  it "delivers a template based notification" do
    result = TestNotification.deliver_now(params: { name: "Neha" })
    expect(result).to be_success
  end

  it "supports deliver_later when active job exists" do
    stub_const("ActiveJob::Base", Class.new)
    expect { TestNotification.deliver_later(params: { name: "Neha" }) }.not_to raise_error
  end

  it "raises for deliver_later without active job" do
    hide_const("ActiveJob")
    expect { TestNotification.deliver_later(params: { name: "Neha" }) }.to raise_error(LoadError)
  end

  it "raises when recipient is missing" do
    expect { ExplicitMessageNotification.deliver_now }.to raise_error(WhatsAppNotifier::ConfigurationError, /recipient/)
  end

  it "raises when template not found" do
    notification = TestNotification.with(template: :unknown)
    expect { notification.message }.to raise_error(WhatsAppNotifier::ConfigurationError, /template not found/)
  end

  it "raises when neither message nor template exist" do
    expect { WhatsAppNotifier::Notification.new.message }.to raise_error(NotImplementedError)
  end

  it "uses explicit message implementation" do
    result = ExplicitMessageNotification.deliver_now(to: "+1")
    expect(result).to be_success
  end
end
