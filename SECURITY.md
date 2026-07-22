# Security policy

## Reporting a vulnerability

Please report security issues privately. Do not open a public GitHub issue for a
vulnerability.

Email **kshtzkr@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- the gem version and environment where you found it.

You can expect an acknowledgement within a few days. Once the issue is confirmed,
a fix will be prepared and released, and you will be credited unless you prefer
to stay anonymous.

Do not include real credentials, session data, phone numbers, or other secrets
in your report.

## Supported versions

Security fixes target the latest released version on the `0.8.x` line. Please
upgrade to the most recent release before reporting, in case the issue is already
fixed.

| Version | Supported |
| --- | --- |
| 0.8.x | yes |
| < 0.8 | no |

## A note on this gem's threat model

This gem automates an unofficial WhatsApp Web session and runs a local service
that drives a browser. Two settings matter for a safe deployment:

- Set `WHATSAPP_WEBHOOK_TOKEN` in production. It gates the service's `/media`,
  `/chats`, and `/history` routes, which expose conversation content.
- Keep the service bound to localhost or an otherwise private network. It has no
  authentication of its own beyond the token above.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for both settings.
