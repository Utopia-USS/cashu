# cashU

A local personal-finance tracker for Polish banks and brokers: Python 3.12 app (CLI, FastAPI, MCP
server) + React dashboard, data per profile, everything runs locally.

> This file is also accessible as `AGENTS.md` (symlink) for tools that follow the OpenAI / Codex
> convention, and `.agents/skills` links to `.claude/skills`. Edit `CLAUDE.md` and `.claude/skills/`;
> the symlinks keep both views in sync.

This file is for the **agent** (Claude Code / any assistant) helping the user run and extend the
project. It is the inventory and routing map; the deep content lives in [`docs/agents/`](docs/agents/).

## Topology

```
cashu/
├── src/cashu/          # Python app: core/ (always on) + modules/<id>/ (budget, assets, loans, investments), api/, desktop/
├── frontend/           # React + Vite + TS SPA (UI strings are Polish), e2e/ = Playwright smoke suite
├── tests/              # pytest - synthetic data only
├── .claude/skills/     # product skills shipped to each profile's agent workspace
├── docs/               # import formats, connector contract + schemas, agents/ = dev guide
├── connectors/         # community connector catalog (contrib status), shipped read-only with the app
├── examples/connectors/, packaging/, scripts/
└── data/, statements/  # git-ignored: legacy data location, CSV drop folder
```

## Data-safety rules (most important - do not break them)

This project works with the user's real financial data. **Never** leak data into the repository or
off the machine:

1. **Never commit data.** These never go into git: `data/**` (DB, backups, keys, sessions),
   `statements/**` (CSVs), `.env`, `*.pem`. They are all in `.gitignore`. Before every commit, run
   `git status` - if you see a data file staged, **stop and report it to the user**. The DB, Open
   Banking sessions and key, backups and the API token now live in the per-user data dir outside the
   repo (`core/paths.py`); `data/` only holds them in older checkouts until `cashu migrate-data`.
   Tests always set `CASHU_DATA_DIR` to a temp dir; `tests/conftest.py` also points HOME, the
   pre-rename data dir, workspaces and launch agents at temp dirs and sets `CASHU_TESTING=1`, under
   which `core/migrate_legacy.py` refuses any path in the real home.
   Outside tests, a git-ignored `.env.dev` at the checkout root (also read by every git worktree of
   it, `src/cashu/_devenv.py`) points CLI, scripts and servers of a dev checkout at a demo data dir.
2. **Never write balances, IBANs, names, or transactions** into files that could land in the repo
   (code, tests, docs). Tests use synthetic data; never paste real statements.
3. **Never send data to a cloud LLM.** The `anthropic` backend sends only the merchant-name string -
   never IBANs, balances, or names. The default backend is local `ollama` (offline). Don't change
   this without the user's explicit OK.
4. **Bank credentials (login/password/SCA) are entered only by the user** in the bank's browser. The
   code never sees them and must never ask for them.
5. **Net worth is computed per-currency** (never sum currencies); **internal transfers are matched by
   counterparty IBAN only** (never by name/amount).
6. **Never run `eb resync` / `reclassify` in a loop** - banks throttle PSD2 (429), and the local LLM
   is slow. Sync ~once a day.
7. **Never query a profile-scoped table without the profile**: data of one profile must never show
   up in another.

Full "What NOT to do" list with reasons: [docs/agents/conventions.md](docs/agents/conventions.md).

## Language convention

The codebase is English (comments, docstrings, CLI help, docs). The **UI is Polish and English**:
every text the app shows lives in both languages (frontend `*.strings.ts` catalogs, backend
`core/i18n.py` `tr(pl=..., en=...)`); the language follows the OS, else English, and Settings can pin
it. Agent-written content (research notes, theses) is shown as written. Full contract and glossary:
[docs/agents/localization.md](docs/agents/localization.md).

**Matching data is intentionally Polish and must stay Polish**: parser CSV headers (`#Data operacji`,
`Rachunek źródłowy`, ...), the ~420 PL keyword rules in `taxonomy.py`, installment phrases in
`loans/patterns.py`, patterns in `engine.py`/`reclassify.py`, LLM prompts in
`local_llm.py`/`reclassify.py`, word lists in `research/validation.py` / `similarity.py`. Translating
them breaks matching on real data.

Rule of thumb: **explanation for a developer -> English; text shown to the user -> both languages
through a catalog / `tr()`; data** (matched, or sent to the LLM as a prompt/enum) **-> Polish**. Never
the em dash; use a hyphen. Full form: [docs/agents/conventions.md](docs/agents/conventions.md).

## Required setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && cashu init-db
cd frontend && npm install && npm run build && cd ..   # webdist/ is git-ignored: build once after clone
```

**If the user is just getting started** -> walk them through setup following
[`ONBOARDING.md`](ONBOARDING.md), step by step, waiting for confirmation after each step.

## Repository overview

cashU pulls transactions from Polish banks (**mBank**, **Erste** / former Santander, **Pekao**) via
CSV export and optionally Open Banking (Enable Banking), normalizes them to a common model,
deduplicates, detects internal transfers between the user's own accounts, categorizes spending, and
computes net worth, monthly cashflow, and recurring payments. Data is kept per **profile** (a person
or a household), and features come in **modules** (budget, assets, loans, investments) chosen per
profile. The dashboard is FastAPI + a React SPA. Everything runs **locally**. Stack: Python 3.12+,
SQLModel/SQLite, Typer (CLI), FastAPI (API), React + Vite + TypeScript + Recharts (frontend).

| Workspace | Purpose |
|---|---|
| `src/cashu/core/` | always on: profiles, accounts, balances, net worth, registries, data dir, migrations, API security, MCP server, worker, connectors, agent workspaces |
| `src/cashu/modules/<id>/` | budget, assets, loans, investments: each owns its tables, router, CLI, setup steps (`ModuleSpec`); never imports another module's internals |
| `src/cashu/api/`, `src/cashu/desktop/` | FastAPI composition + SPA serving; `cashu app` desktop window and packaged-app entry |
| `frontend/` | React SPA: `src/core/` shell, `src/modules/<id>/` tabs, v2 widgets and SVG charts; `e2e/` Playwright |
| `tests/` | pytest on synthetic data; guard tests for profile isolation, migrations, skills |
| `.claude/skills/` | the 9 shipped product skills (inventory below) |
| `docs/` | `import-format.md`, `budget-import-format.md`, `connectors.md`, `schemas/`, `agents/` |
| `examples/connectors/`, `packaging/`, `scripts/` | example connectors; macOS app build; build, version bump, demo data, schema / skill-reference sync |

Full file-level map: [docs/agents/code-map.md](docs/agents/code-map.md).

## Skills inventory

These are **product skills**, not dev tooling: they ship with cashU and are copied into each
profile's agent workspace (`src/cashu/core/workspace`). Every skill follows the utopia-ai-arch:layer
shape (POSITIVE / NEGATIVE applicability in the description, References table, See also, Self-audit);
`tests/test_workspace.py::test_shipped_skills_follow_the_layer_shape` enforces it. A new skill must be
added to `MODULE_SKILLS` / `CORE_SKILLS` in `src/cashu/core/workspace/skills.py`. Details and editing
rules: [docs/agents/skills.md](docs/agents/skills.md).

| Skill | Module | Applicability |
|---|---|---|
| `workspace-setup` | core | Agent layout of a profile workspace (CLAUDE.md inventory, `AGENTS.md` + `.agents/skills` links for Codex) and the user's own skills in the same shape - NOT module setup, importers, portfolio rules or research |
| `budget-setup` | budget | Budget module setup: install check, banks, CSV vs Open Banking, categorization backend (Ollama vs Anthropic), first categorization pass via MCP - NOT broker exports, manual assets, loans or investments |
| `assets-setup` | assets | Manually valued assets (property, car with a depreciation curve, other), CLI placeholders, revaluing, MCP check - NOT loans, bank accounts and cash, or brokerage accounts |
| `loans-setup` | loans | Each loan's terms, installments recognised by a title phrase, balance the bank reports, MCP check - NOT the property or car itself, bank imports or spending categories |
| `investments-setup` | investments | Strategy interview (goals, horizon, risk, history retrospective), strategy.md + strategy.yaml proposals, weekly / monthly / quarterly check-ins - NOT broker-export conversion, one custom rule or market research; never recommends instruments or trades |
| `import-builder` | budget, investments | Broker / exchange / crypto history or bank statements turned into a file or fetch connector (preferred), a one-off converter or a generic CSV mapping - NOT supported bank CSV / Open Banking imports, strategy or custom rules |
| `extension-builder` | investments | One monitoring idea as a built-in rule kind or safe custom expression (`propose_custom_rule`), backtested and tuned - NOT a whole strategy, imports or alert proposals after a research run |
| `review` | investments | The periodic review deck in chat (world, sectors, positions, events, ideas, calendar, decide) from `review_context`, decisions, `mark_review_done` with the agenda; the strategy.yaml `review:` section - NOT the strategy, research runs, rules or imports |
| `market-research` | investments | Held / watched instruments, topics, macro cards, candidates and theses researched over MCP into sourced Polish notes, topic market views and model recommendations - NOT strategy or thesis writing, custom rules, imports or placing trades |

(Inventory only - descriptions live in each `SKILL.md` frontmatter.)

## When to Invoke

| Situation | Read first | Files / guards |
|---|---|---|
| Orient in the code, find where something lives | [code-map.md](docs/agents/code-map.md) | - |
| Touch money, net worth, transfers, loans, cash, categorization, investments math | [data-model.md](docs/agents/data-model.md) | `core/networth.py`, `modules/<id>/networth.py` |
| Add a module | [extending.md](docs/agents/extending.md) "Adding a module" | `core/modules.py` `MODULE_IDS`, `ModuleSpec` |
| Add an API route / dashboard feature | [extending.md](docs/agents/extending.md) "Adding a dashboard feature" | `tests/test_profiles.py` `PROFILE_GETS`, `tests/investments/persistence/test_invp_isolation.py` |
| Add an MCP tool | [extending.md](docs/agents/extending.md) "Adding an MCP tool" | `core/mcp/registry.py`, `labels.py`, `redaction.py`, `tools/<module>.py` |
| Change a model / add a migration | [data-model.md](docs/agents/data-model.md) rule 15 | `core/migrations/versions/`, `tests/test_migrations.py` |
| Add a bank CSV parser | [extending.md](docs/agents/extending.md) "Adding a new bank" | `csv_import/base.py`, `core/institutions.py` `BUILTIN`, `tests/test_parsing.py` |
| Add an importer / connector | [extending.md](docs/agents/extending.md), [docs/connectors.md](docs/connectors.md), [connectors/README.md](connectors/README.md) (catalog) | `docs/import-format.md`, `docs/budget-import-format.md`, `examples/connectors/`, `scripts/gen_connector_schemas.py`, `tests/test_connector_catalog.py` |
| Add a CLI command | [conventions.md](docs/agents/conventions.md) "CLI" | module `cli.py`, `core/cliutil.py` |
| Edit or add a shipped skill | [skills.md](docs/agents/skills.md) | `core/workspace/skills.py`, `scripts/sync_skill_references.py`, `tests/test_workspace.py` |
| Add or change any user-visible text (UI copy, backend label, notification) | [localization.md](docs/agents/localization.md) | `frontend/src/i18n.ts`, `*.strings.ts`, `src/cashu/core/i18n.py`, `frontend/tests/i18n-guard.test.mjs` |
| Frontend change (UI copy, charts, API client) | [conventions.md](docs/agents/conventions.md) "Frontend copy", [extending.md](docs/agents/extending.md) | `frontend/src/core/messages.ts`, `charts.tsx`, `frontend/e2e/specs/` |
| Research / MCP privacy (what the agent may see) | [skills.md](docs/agents/skills.md) "Rules every skill follows" | `core/mcp/redaction.py`, `core/mcp/labels.py`, `tests/test_fxb_mcp_privacy.py` |
| Run, demo data, e2e, verify in the browser | [running.md](docs/agents/running.md) | `.claude/launch.json`, `scripts/demo_data.py` |
| Write tests | [conventions.md](docs/agents/conventions.md) "Tests" | `tests/conftest.py`, `tests/upstream_db.py` |
| Packaging / desktop app build | [packaging/README.md](packaging/README.md) | `scripts/build_macos.sh`, `packaging/cashu.spec` |
| Release to installed apps (owner only) | [packaging/RELEASING.md](packaging/RELEASING.md) | `scripts/release_macos.sh`, `scripts/make_appcast.py`, `desktop/updater.py` |
| Versioning / release | [conventions.md](docs/agents/conventions.md) "Versions" | `.github/workflows/bump-version.yml`, `scripts/bump_version.py` |
| Help the end user set up | [ONBOARDING.md](ONBOARDING.md) | the module setup skills |

## Common commands

| Task | Command |
|---|---|
| Install (dev) | `pip install -e ".[dev]"` (inside `.venv`) |
| Create / upgrade the DB | `cashu init-db` (every command and server start also upgrades to head) |
| Tests (synthetic data - safe) | `pytest` |
| Lint | `ruff check src tests` (configured in `pyproject.toml`) |
| Build the dashboard | `cd frontend && npm install && npm run build` |
| Serve the dashboard | `cashu serve` (http://127.0.0.1:8500) |
| Dev mode with HMR | `cashu serve` + `cd frontend && npm run dev` (Vite :5173, proxies `/api` -> :8500) |
| Desktop window | `cashu app` |
| Frontend typecheck / unit tests | `cd frontend && npm run typecheck` / `npm test` |
| Browser e2e | `cd frontend && npm run build && npm run e2e` (one spec: `npm run e2e -- specs/05-alerts.spec.ts`) |
| Demo data | `.venv/bin/python scripts/demo_data.py --data-dir /tmp/cashu-demo`, then `CASHU_DATA_DIR=/tmp/cashu-demo cashu serve` |
| New migration | `CASHU_DATA_DIR=/tmp/x alembic revision --autogenerate -m "..."` (repo root) |
| Regenerate connector schemas | `python scripts/gen_connector_schemas.py` (`--check` to verify) |
| Refresh skill reference copies | `python scripts/sync_skill_references.py` (`--check` to verify) |
| Connect a profile's MCP server | `claude mcp add cashu-<slug> -- cashu mcp --profile <slug>` |
| Profile agent workspace | `cashu workspace init` / `cashu workspace update` |
| Move legacy `data/` into the data dir | `cashu migrate-data` |
| Build cashU.app (macOS) | `scripts/build_macos.sh` |

## Documentation

- [docs/agents/code-map.md](docs/agents/code-map.md) - file-level repository map
- [docs/agents/data-model.md](docs/agents/data-model.md) - how the numbers work, live data, migrations
- [docs/agents/conventions.md](docs/agents/conventions.md) - language, versions, CLI, tests, UI copy, what NOT to do
- [docs/agents/localization.md](docs/agents/localization.md) - Polish / English UI: language choice, catalogs, backend `tr()`, glossary
- [docs/agents/extending.md](docs/agents/extending.md) - recipes: bank, module, dashboard feature, MCP tool, migration, connector
- [docs/agents/running.md](docs/agents/running.md) - running, demo data, e2e
- [docs/agents/skills.md](docs/agents/skills.md) - shipped skills, their rules, editing them
- [docs/agents/connector-runtime.md](docs/agents/connector-runtime.md) - design spike: connectors on macOS, Linux and Windows (Deno tier)
- [ONBOARDING.md](ONBOARDING.md) - end-user setup the agent walks through
- [README.md](README.md) - product overview
- [docs/connectors.md](docs/connectors.md), [docs/import-format.md](docs/import-format.md), [docs/budget-import-format.md](docs/budget-import-format.md) - external formats and contracts
- [packaging/README.md](packaging/README.md) - macOS build decisions
