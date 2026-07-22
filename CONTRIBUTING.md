# Contributing

Thanks for taking the time to contribute. Bug reports, fixes, and documentation
improvements are all welcome.

## Getting set up

```bash
git clone https://github.com/kshtzkr/whatsapp_notifier.git
cd whatsapp_notifier
bundle install
```

Run the Ruby test suite:

```bash
bundle exec rspec
```

SimpleCov enforces 100% line coverage, so a change that adds Ruby code needs
matching specs.

The bundled service under `lib/whatsapp_notifier/services/web_automation` has its
own tests. If you touch it, install [Bun](https://bun.sh) and run them:

```bash
cd lib/whatsapp_notifier/services/web_automation
bun install
bun test
```

## Branch and pull request flow

1. Create a topic branch off `main` (for example `fix/qr-timeout` or
   `docs/configuration`).
2. Make your change with tests.
3. Open a pull request against `main` with a clear description of what changed
   and why.
4. CI (`.github/workflows/ci.yml`) runs RSpec on Ruby 3.2–3.4 and the Bun
   service tests. It must pass before a change is merged.

Keep pull requests focused. Unrelated changes are easier to review as separate
PRs.

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org).
Prefix the summary with a type and optional scope:

```
docs(readme): add configuration table
fix(bulk): honor wait_seconds on retry
chore: bump rubocop
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`. Make each
commit one logical change.

## Reporting bugs

Open an issue at
https://github.com/kshtzkr/whatsapp_notifier/issues with the gem version, Ruby
version, and steps to reproduce. For security issues, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
