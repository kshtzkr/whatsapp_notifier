WhatsAppNotifier::Engine.routes.draw do
  get  "status", to: "sessions#show", as: :status
  get  "qr",     to: "sessions#qr",   as: :qr
  post "send",   to: "messages#create", as: :send_message
end
