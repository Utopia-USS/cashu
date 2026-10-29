# Security policy

cashU keeps people's financial data on their own machine. A bug that lets that data out, or lets
someone else act on it, is a security issue and we want to hear about it.

## Reporting a vulnerability

Report privately through GitHub: **Security > Report a vulnerability** on
[github.com/Utopia-USS/cashu](https://github.com/Utopia-USS/cashu/security/advisories/new). Do not
open a public issue, pull request or discussion for it.

Please include:

- what an attacker can do and under which conditions (local user, web page in the browser, malicious
  connector, malicious import file, ...);
- steps to reproduce on synthetic data, and the version or commit you tested;
- never real statements, balances, account numbers or credentials, yours or anyone's.

We aim to acknowledge a report within a week and agree on a fix and disclosure timeline with you.
Fixes land on `main`; there are no separately maintained release branches.

## In scope

- **Data leaks**: financial data, account identifiers or names leaving the machine, reaching another
  profile, landing in logs, the repository or agent workspaces, or getting past the MCP privacy layer
  (`src/cashu/core/mcp/redaction.py`) to an agent at a stricter privacy level than the profile allows.
- **Connector sandbox escapes**: an approved or pending connector reading or writing outside what the
  contract allows, reaching hosts not listed in its manifest, running without the owner's approval or
  after its content changed ([`docs/connectors.md`](docs/connectors.md)).
- **The local API token**: the dashboard API accepting a request without the per-launch token, the
  token leaking (to another origin, a log, a URL kept beyond the first load), or the server answering
  on anything but loopback by default.
- Secrets handling: Open Banking keys and sessions, API keys in the OS keychain.

## Out of scope

- Someone with full access to the user's account on the machine (they can read the data dir anyway).
- A connector or file the owner deliberately approved or handed to an agent doing what it says.
- Bank, broker or Open Banking provider issues: report those to the provider.
- Missing hardening without a concrete attack (headers, rate limits on a loopback server).
