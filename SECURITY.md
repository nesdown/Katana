# Security

Report vulnerabilities privately through GitHub Security Advisories on this repository.

## What Katana defends against

- **Server-side request forgery.** URLs found in scraped content cannot reach private networks or cloud metadata addresses, including through redirects. DNS is checked before connecting. A determined DNS rebinding attacker could still race this check, so run bots without access to sensitive internal services.
- **Prompt injection.** Scraped text is fenced off, models are told not to follow it, and links they invent are removed. No filter is perfect: use `approve` for anything sensitive.
- **Mention bombs.** Discord pings are disabled and Slack control sequences escaped, so scraped text cannot alert a whole channel.
- **Disguised files.** Images are identified from their bytes and capped in size. SVG and HTML are refused.
- **Secret leaks.** Tokens are stripped from URLs in logs and errors.

## Your part

Keep credentials in `.env` or your host's secret store and never in code. Use app passwords where offered. Keep `.katana/` private: it holds post history.
