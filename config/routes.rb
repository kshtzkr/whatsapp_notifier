WhatsAppNotifier::Engine.routes.draw do
  get    "status",  to: "sessions#show",     as: :status
  get    "qr",      to: "sessions#qr",       as: :qr
  delete "logout",  to: "sessions#destroy",  as: :logout
  post   "send",    to: "messages#create",   as: :send_message
  get    "inbound", to: "messages#inbound",  as: :inbound
end
