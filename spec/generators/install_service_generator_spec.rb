require "spec_helper"
require "fileutils"

# The generator runs inside a Rails app; here we stand in a minimal
# Rails::Generators::Base double (same approach as railtie_spec) so the eject
# logic sits under the coverage gate without depending on the rails gem.
#
# Loaded ONCE at spec-file load time: Ruby's Coverage module zeroes a file's
# line counters whenever it is re-`load`ed, so loading per-example would erase
# the coverage recorded by earlier examples.
INSTALL_SERVICE_GENERATOR = begin
  fake_base = Class.new do
    class << self
      def source_root(path = nil)
        @source_root = path if path
        @source_root
      end
    end

    attr_reader :copied, :appended, :said

    def initialize
      @copied = []
      @appended = []
      @said = []
    end

    def copy_file(source, destination)
      @copied << [source, destination]
    end

    def append_to_file(path, content)
      @appended << [path, content]
    end

    def say(message, _color = nil)
      @said << message
    end
  end

  rails = Module.new
  rails.const_set(:Generators, Module.new)
  rails::Generators.const_set(:Base, fake_base)
  Object.const_set(:Rails, rails)

  load File.expand_path("../../lib/generators/whatsapp_notifier/install_service_generator.rb", __dir__)
  Object.send(:remove_const, :Rails) # don't leak the fake into railtie_spec

  WhatsAppNotifier::Generators::InstallServiceGenerator
end

RSpec.describe "WhatsAppNotifier::Generators::InstallServiceGenerator" do
  let(:generator_class) { INSTALL_SERVICE_GENERATOR }

  describe "#copy_service_files" do
    it "ejects only the runnable service source — no node_modules, caches or tests" do
      generator = generator_class.new
      generator.copy_service_files

      sources = generator.copied.map(&:first)
      expect(sources).to match_array(%w[index.ts inbound.ts init_gate.ts metrics.ts sessions.ts package.json bun.lock])
      expect(sources.grep(/test|node_modules|\.wwebjs|\.puppeteer/)).to be_empty
      expect(generator.copied.map(&:last)).to all(start_with("whatsapp_service/"))
    end

    it "lists only files that actually exist in the gem service dir" do
      generator_class.const_get(:SERVICE_FILES).each do |file|
        expect(File).to exist(File.join(generator_class.source_root, file)),
                        "SERVICE_FILES lists #{file} but it is missing from the service dir"
      end
    end
  end

  describe "#add_to_gitignore" do
    around do |example|
      Dir.mktmpdir { |dir| Dir.chdir(dir) { example.run } }
    end

    it "appends all entries when .gitignore is missing" do
      generator = generator_class.new
      generator.add_to_gitignore

      path, content = generator.appended.first
      expect(path).to eq(".gitignore")
      expect(content).to include("/whatsapp_service/node_modules", "/whatsapp_service/.wwebjs_auth")
    end

    it "appends only the missing entries" do
      File.write(".gitignore", "# WhatsApp Service\n/whatsapp_service/node_modules\n")

      generator = generator_class.new
      generator.add_to_gitignore

      _path, content = generator.appended.first
      expect(content).to include("/whatsapp_service/.wwebjs_cache")
      expect(content).not_to include("node_modules")
    end

    it "does nothing when every entry is already present" do
      File.write(".gitignore", <<~GITIGNORE)
        # WhatsApp Service
        /whatsapp_service/node_modules
        /whatsapp_service/.wwebjs_cache
        /whatsapp_service/.wwebjs_auth
      GITIGNORE

      generator = generator_class.new
      generator.add_to_gitignore

      expect(generator.appended).to be_empty
    end
  end

  describe "#show_readme" do
    it "prints the post-install instructions" do
      generator = generator_class.new
      generator.show_readme

      expect(generator.said.join("\n")).to include("WhatsApp Service installed", "bun index.ts")
    end
  end
end
