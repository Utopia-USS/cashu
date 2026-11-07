# Contributing to cashU

Thanks for helping. cashU handles people's real financial data, so a few rules here are strict;
everything else follows the usual GitHub flow: open an issue or a pull request against `staging`
(changes reach `main`, and with it a release, through the `staging -> main` pull request).

Before you change code, read [`CLAUDE.md`](CLAUDE.md) (the map of the repository and the
data-safety rules) and [`docs/agents/conventions.md`](docs/agents/conventions.md) (language, tests,
UI copy, what not to do). If you work with an AI agent, it reads the same files.

## Development setup

You need Node.js 22 (`.nvmrc`) and pnpm (`corepack enable`; the version is pinned in `package.json`).
macOS is the primary platform; the CLI and the tests also run on Linux.

```bash
git clone https://github.com/Utopia-USS/cashu.git && cd cashu
corepack enable && pnpm install --frozen-lockfile
```

To look at the app without your own data, run the desktop app on its synthetic demo (generated on the
first run into `~/cashu-lab/desktop-demo`; `CASHU_DATA_DIR` picks another folder):

```bash
pnpm --filter @cashu/desktop dev
```

If you also use cashU for your real finances, keep the checkout off your real data dir for good: put
the dev defaults into a git-ignored `.env.dev` at the checkout root. The `cashu` command started from
this checkout (`pnpm cashu-next ...`) fills unset `CASHU_*` variables from it, and so does every
`git worktree` of the checkout (it reads the main checkout's file). The packaged app and the test
suite never read it.

```bash
printf '%s\n' "CASHU_DATA_DIR=$HOME/cashu-lab/desktop-demo" "CASHU_WORKSPACES_DIR=$HOME/cashu-lab/desktop-demo-ws" > .env.dev
```

More on running, demo data, the desktop e2e suite and packaging:
[`docs/agents/running.md`](docs/agents/running.md).

## Checks

CI (`.github/workflows/ts.yml`) runs these on every pull request, on Linux and macOS; run them before
you push.

| What | Command |
|---|---|
| Typecheck, lint, tests | `pnpm check` (`pnpm typecheck`, `pnpm lint`, `pnpm test`) |
| Exhaustive test tier | `pnpm test:exhaustive` |
| Architecture checks | `pnpm arch:check` |
| Mobile bundle budget | `pnpm bundle:check` |
| Generated files | `pnpm --filter @cashu/host gen:connector-schemas --check` and `pnpm --filter @cashu/host skills:sync --check` |
| Desktop e2e (not in CI) | `pnpm --filter @cashu/desktop build && pnpm --filter @cashu/desktop e2e` |

`pnpm check:handoff` runs the first three rows in one go.

## Data safety

- **Synthetic data only.** Tests, fixtures, docs and screenshots never contain real balances, IBANs,
  account numbers, names or transactions. Never paste a real statement, not even a redacted one.
  Tests use temp data dirs and the test key store (`createTestKeyStore`, keychain namespace
  `cashu-next-test.*`); never the real data dir or a real keychain item.
- **Never commit data.** `data/**`, `statements/**`, `.env*` and `*.pem` are git-ignored. Run
  `git status` before every commit; if a data file is staged, unstage it.
- **Nothing leaves the machine unless the owner turned it on.** The default categorizer is local
  (Ollama); the cloud backend sends only the merchant name. Do not add network calls, telemetry or
  cloud services without discussing it in an issue first.
- **Bank credentials are entered only by the user**, in the bank's own page. Code never asks for or
  sees them.
- **Money rules:** net worth is computed per currency (never sum currencies); internal transfers are
  matched by counterparty IBAN only; each profile is its own vault and nothing reads across vaults.

## Banks, brokers and other data sources

cashU does not take new bank or broker parsers into the core. A new source is a **connector**: a small
program in any language with a `connector.yaml` manifest that converts an export file or fetches from
an API, run by the app in a sandbox after the owner approves it. The contract, protocol and testing
command are in [`docs/connectors.md`](docs/connectors.md); working examples are in
[`examples/connectors/`](examples/connectors/).

Community connectors live in the top-level [`connectors/`](connectors/) catalog, which ships with
the app (also the downloaded one). They have contrib status:

- each connector has a named maintainer (usually its author, `maintainer` in its manifest), who keeps
  it working when the bank or broker changes its format or API;
- the core team reviews connectors for safety (manifest, network hosts, what they output), not for
  ongoing correctness;
- a connector that fails its tests or was not verified for 180 days is flagged unmaintained, not fixed
  by the core team, until its maintainer or another contributor fixes it, so a broken connector never
  blocks a core pull request.

Layout, the pull request checklist and how a user's agent installs an entry:
[`connectors/README.md`](connectors/README.md). To discuss a source before you write a connector, open
an issue with the "New data source" template.

## Code style

- English for code, comments, CLI help and docs. Every text the app shows exists in Polish and English
  (`*.strings.ts` catalogs); the matching data (CSV headers, categorization keywords, LLM prompts)
  stays Polish: it is domain data, see [`docs/agents/conventions.md`](docs/agents/conventions.md) and
  [`docs/agents/localization.md`](docs/agents/localization.md).
- Never use the em dash character; use a hyphen.
- A module never imports another module's internals; cross-module needs go through `core`; packages
  follow the layer table (`pnpm arch:check`).
- Stored events never change: an event change is a new version with an upcaster, a view change a
  version bump ([`docs/agents/data-model.md`](docs/agents/data-model.md) rule 15).
- Do not bump the version (`apps/desktop/package.json`); the `bump-version` workflow does it on the merge to `main`,
  and the release follows after the owner's approval ([`docs/releasing.md`](docs/releasing.md)).

## Commits and pull requests

Commit messages are one imperative sentence in sentence case, with no type prefix and no trailing
period, describing the change for a user of the app where possible:

```
Add an instrument merge for duplicate instruments
Show the macro regime cards on the research page, the home strip and the review
Round amount-labelled MCP values so the leak check does not withhold whole answers
```

Not `feat: add merge` and not `Added merge.`. Add a body when the reason is not obvious from the
diff.

Keep a pull request to one topic, update the docs it affects (including `CLAUDE.md` and
`docs/agents/` when you change structure), and fill in the checklist of the pull request template.

## Security

Report vulnerabilities privately, not in a public issue: see [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
