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

  it "caches qr code per user_id when metadata is provided" do
    Dir.mktmpdir do |dir|
      store = WhatsAppNotifier::Session::Store.new(path: File.join(dir, "s.json"))
      adapter = double
      allow(adapter).to receive(:fetch_qr_code).and_return("qr-user-1", "qr-user-2")
      service = described_class.new(store: store, adapter: adapter)

      expect(service.qr_code(metadata: { user_id: 1 })).to eq("qr-user-1")
      expect(service.qr_code(metadata: { user_id: 1 })).to eq("qr-user-1")
      expect(service.qr_code(metadata: { user_id: 2 })).to eq("qr-user-2")

      expect(adapter).to have_received(:fetch_qr_code).twice
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
