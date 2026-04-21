require "spec_helper"

RSpec.describe WhatsAppNotifier::Session::QrService do
  it "fetches qr from adapter and persists it" do
    Dir.mktmpdir do |dir|
      store = WhatsAppNotifier::Session::Store.new(path: File.join(dir, "s.json"))
      adapter = double(fetch_qr_code: "qr-1")
      service = described_class.new(store: store, adapter: adapter)

      expect(service.qr_code).to eq("qr-1")
      expect(service.qr_code).to eq("qr-1")
    end
  end

  it "activates a session token" do
    Dir.mktmpdir do |dir|
      store = WhatsAppNotifier::Session::Store.new(path: File.join(dir, "s.json"))
      adapter = double(fetch_qr_code: "qr-2")
      service = described_class.new(store: store, adapter: adapter)
      service.qr_code

      service.activate!("tok")

      expect(store.load).to include(active: true, token: "tok", qr_code: nil)
    end
  end
end
