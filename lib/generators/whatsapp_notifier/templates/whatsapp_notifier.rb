WhatsAppNotifier.configure do |config|
  config.provider = :web_automation
  config.web_automation_enabled = true

  # Auth hook — runs as a before_action inside the engine's controllers.
  # Use whatever your app exposes (Devise, custom, etc.).
  # config.authenticate_with = -> { authenticate_user! }

  # How the engine identifies the current user (used as metadata when
  # talking to the bun WhatsApp service). Default uses Devise-style
  # current_user.id; override if your app names it differently.
  # config.current_user_id_resolver = -> { current_user&.id }

  # Parent class for the engine's controllers. Defaults to
  # "::ApplicationController" so the engine inherits your app's layout,
  # helpers, and any global before_actions.
  # config.parent_controller = "::ApplicationController"
end

ENV["WHATSAPP_NOTIFIER_SERVICE_URL"] ||= ENV["WHATSAPP_SERVICE_URL"] || "http://127.0.0.1:3001"
