# Contributing to cashU

Thanks for helping. cashU handles people's real financial data, so a few rules here are strict;
everything else follows the usual GitHub flow: open an issue or a pull request against `main`.

Before you change code, read [`CLAUDE.md`](CLAUDE.md) (the map of the repository and the
data-safety rules) and [`docs/agents/conventions.md`](docs/agents/conventions.md) (language, tests,
UI copy, what not to do). If you work with an AI agent, it reads the same files.

## Development setup

You need Python 3.12+ and Node.js 20+.

```bash
git clone https://github.com/Utopia-USS/cashu.git && cd cashu
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" -c constraints.txt   # constraints.txt pins the tested versions
cashu init-db
cd frontend && npm ci && npm run build && cd ..   # webdist/ is git-ignored: build once after clone
```

To look at the app without your own data, generate the synthetic demo household in a separate data
dir:

```bash
python scripts/demo_data.py --data-dir /tmp/cashu-demo
CASHU_DATA_DIR=/tmp/cashu-demo cashu serve
```

More on running, demo data and the browser e2e suite: [`docs/agents/running.md`](docs/agents/running.md).

## Checks

CI runs these on every pull request; run them before you push.

| What | Command |
|---|---|
| Lint | `ruff check src tests` |
| Python tests | `pytest` |
| Generated files | `python scripts/gen_connector_schemas.py --check` and `python scripts/sync_skill_references.py --check` |
| Frontend typecheck | `cd frontend && npm run typecheck` |
| Frontend unit tests | `cd frontend && npm test` |
| Frontend build | `cd frontend && npm run build` |
| Browser e2e (not in CI) | `cd frontend && npm run build && npm run e2e` |

The Python tests run on Linux and macOS (required) and Windows (informational for now: cashU is meant
to run on every OS, and Windows fixes are welcome).

## Data safety

- **Synthetic data only.** Tests, fixtures, docs and screenshots never contain real balances, IBANs,
  account numbers, names or transactions. Never paste a real statement, not even a redacted one.
  `tests/conftest.py` points the data dir, HOME and agent workspaces at temp dirs; keep it that way.
- **Never commit data.** `data/**`, `statements/**`, `.env` and `*.pem` are git-ignored. Run
  `git status` before every commit; if a data file is staged, unstage it.
- **Nothing leaves the machine unless the owner turned it on.** The default categorizer is local
  (Ollama); the cloud backend sends only the merchant name. Do not add network calls, telemetry or
  cloud services without discussing it in an issue first.
- **Bank credentials are entered only by the user**, in the bank's own page. Code never asks for or
  sees them.
- **Money rules:** net worth is computed per currency (never sum currencies); internal transfers are
  matched by counterparty IBAN only; profile-scoped tables are always queried with the profile.

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
  by the core team, until its maintainer or another contributor fixes it. The catalog has its own,
  informational CI job, so a broken connector never blocks a core pull request.

Layout, the pull request checklist and how a user's agent installs an entry:
[`connectors/README.md`](connectors/README.md). To discuss a source before you write a connector, open
an issue with the "New data source" template.

## Code style

- English for code, comments, docstrings, CLI help and docs. Dashboard UI strings and the matching
  data (CSV headers, categorization keywords, LLM prompts) stay Polish: they are domain data, see
  [`docs/agents/conventions.md`](docs/agents/conventions.md).
- Never use the em dash character; use a hyphen.
- A module never imports another module's internals; cross-module needs go through `core`.
- Schema changes are Alembic migrations with a test ([`docs/agents/data-model.md`](docs/agents/data-model.md)).
- Do not bump the version: a workflow does it after every push to `main`.

## Commits and pull requests

Commit messages are one imperative sentence in sentence case, with no type prefix and no trailing
period, describing the change for a user of the app where possible:

```
Add an instrument merge for duplicate instruments
Show the macro regime cards on the research page, the home strip and the review
Round amount-labelled MCP values so the leak check does not withhold whole answers
```

Not `feat: add merge` and not `Added merge.`. Add a body when the reason is not obvious from the
diff. `[minor]` or `[major]` in a message asks the version workflow for a bigger step.

Keep a pull request to one topic, update the docs it affects (including `CLAUDE.md` and
`docs/agents/` when you change structure), and fill in the checklist of the pull request template.

## Security

Report vulnerabilities privately, not in a public issue: see [`SECURITY.md`](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
