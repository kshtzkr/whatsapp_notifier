require_relative "lib/whatsapp_notifier/version"

Gem::Specification.new do |spec|
  spec.name = "whatsapp_notifier"
  spec.version = WhatsAppNotifier::VERSION
  spec.authors = ["WhatsApp Notifier Team"]
  spec.email = ["maintainers@example.com"]

  spec.summary = "Rails-friendly WhatsApp notifications with pluggable providers"
  spec.description = "Plug-and-play WhatsApp notifier gem with provider abstraction, bulk messaging safeguards, and mailer-like API."
  spec.homepage = "https://example.com/whatsapp_notifier"
  spec.required_ruby_version = ">= 2.6.0"

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://example.com/whatsapp_notifier/source"
  spec.metadata["changelog_uri"] = "https://example.com/whatsapp_notifier/changelog"

  spec.files = Dir.glob("{lib,docs,examples,spec}/**/*") + %w[README.md Gemfile Rakefile]
  spec.require_paths = ["lib"]

  spec.add_dependency "logger", ">= 1.5"
end
