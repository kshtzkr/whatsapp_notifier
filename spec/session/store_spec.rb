require "spec_helper"

RSpec.describe WhatsAppNotifier::Session::Store do
  it "returns empty hash when file is absent" do
    Dir.mktmpdir do |dir|
      store = described_class.new(path: File.join(dir, "missing.json"))
      expect(store.load).to eq({})
    end
  end

  it "saves and loads json data" do
    Dir.mktmpdir do |dir|
      path = File.join(dir, "session.json")
      store = described_class.new(path: path)

      store.save(active: true, token: "abc")

      expect(store.load).to eq(active: true, token: "abc")
    end
  end
end
