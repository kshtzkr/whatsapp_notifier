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

- Set `WHATSAPP_WEBHOOK_TOKEN` whenever the service is reached from another host
  or container. With it set, every route except `/health` requires it.
- Without a token the service answers only callers on its own machine
  (loopback). Every other request gets a 401.

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for both settings.
