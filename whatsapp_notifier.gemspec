require_relative "lib/whatsapp_notifier/version"

Gem::Specification.new do |spec|
  spec.name = "whatsapp_notifier"
  spec.version = WhatsAppNotifier::VERSION
  spec.authors = ["Kshitiz Sinha"]
  spec.email = ["kshtzkr@gmail.com"]

  spec.summary = "Production-ready WhatsApp messaging for Rails"
  spec.description = "Add WhatsApp messaging to Rails in minutes with one install generator and one service command. Supports QR auth, multi-user sessions, mailer-style notifications, and safer bulk delivery with retries and rate limiting."
  spec.homepage = "https://github.com/kshtzkr/whatsapp_notifier"
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6.0"

  spec.metadata["allowed_push_host"] = "https://rubygems.org"
  spec.metadata["homepage_uri"] = spec.homepage
  spec.metadata["source_code_uri"] = "https://github.com/kshtzkr/whatsapp_notifier/tree/main"
  spec.metadata["changelog_uri"] = "https://github.com/kshtzkr/whatsapp_notifier/releases"
  spec.metadata["bug_tracker_uri"] = "https://github.com/kshtzkr/whatsapp_notifier/issues"
  spec.metadata["rubygems_mfa_required"] = "true"

  spec.files = Dir.glob("{bin,lib,docs,examples,spec}/**/*") + %w[README.md LICENSE.txt Gemfile Rakefile]
  spec.executables = ["whatsapp_notifier"]
  spec.require_paths = ["lib"]

  spec.add_dependency "logger", ">= 1.5"
  spec.add_dependency "thor", ">= 1.0"
end

