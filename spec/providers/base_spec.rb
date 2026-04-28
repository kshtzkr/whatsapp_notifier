require "spec_helper"

RSpec.describe WhatsAppNotifier::Providers::Base do
  let(:provider) { described_class.new(configuration: WhatsAppNotifier.configuration) }

  it "requires deliver implementation" do
    expect { provider.deliver({}) }.to raise_error(NotImplementedError)
  end

  it "does not support qr by default" do
    expect { provider.scan_qr }.to raise_error(NotImplementedError)
  end

  it "does not support connection status by default" do
    expect { provider.connection_status }.to raise_error(NotImplementedError)
  end
end
