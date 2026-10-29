# Code map

What this is: the inventory of the repository (what lives where), so an agent reuses existing code instead of reinventing it.

## How to use this

Find the file that owns a concern before adding one. The app is a **core** plus **modules**: core is
always on (profiles, accounts, balances, net worth, registries, data dir, migrations, local API
security); each module owns its tables, API router, CLI commands and blank-page setup steps and
registers them with a `ModuleSpec`. A module never imports another module's internals: cross-module
needs go through core (net-worth contributors, account types, institutions, categorization hooks).
Rows marked (+) were added when this map moved out of `AGENTS.md`; they describe files that existed
but were not listed before.

## `src/cashu/` (top level)

| Path | Purpose |
|---|---|
| `cli.py` | Typer root: `--profile`, core + module commands, `stats` (entry point) |
| `config.py` | Settings (pydantic-settings), reads the checkout's `.env`, then `<data dir>/.env` (wins; the packaged app's) (`CASHU_` prefix) |
| `models.py` | facade: every table (scripts, Alembic env) |
| `db.py` | alias of `core/db.py` (`cashu.db.engine` still works) |
| `desktop/` | `cashu app` (pywebview window over in-process uvicorn, single instance), `cashu skills install`, `entry.py` = the packaged app's entry point, `updater.py` = Sparkle auto-update of cashU.app (own user driver; the dashboard card is its UI) |
| `api/app.py` | FastAPI composition: `/api/p/{slug}/...` + legacy `/api/...` aliases, SPA |
| `api/static/index.html` | fallback page "build the frontend" (when `webdist/` is absent) |
| `api/webdist/` | built React SPA (git-ignored, `npm run build`) |

## `src/cashu/core/`

| Path | Purpose |
|---|---|
| `db.py` | SQLite engine + pragmas (WAL, busy_timeout, foreign_keys), `init_db` |
| `models.py` | Profile, ProfileModule, Account, Balance (+ AccountType, Source) |
| `profiles.py` | profiles, slugs, the default profile, module choice per profile |
| `modules.py` | `ModuleSpec` + registry (`cashu/modules/<id>/module.py`), `MODULE_IDS` |
| `account_types.py` | account type registry: sign, liquid, net-worth bucket, PL label |
| `institutions.py` | bank/broker registry: CSV importer, Open Banking ASPSP names (`BUILTIN`) |
| `accounts.py` | `get_or_create_account`, balances, own IBANs (per profile) |
| `networth.py` | net worth per currency from module `NetWorthContributor`s |
| `api.py` | profile resolution, `/api/system(/update)`, `/modules`, `/profiles`, accounts, net worth |
| `updates.py` | update check: version vs `pyproject.toml` on a GitHub branch (`CASHU_UPDATE_*`) |
| `cli.py` | `init-db`, `serve`, `migrate-data`, `accounts`, `set-balance`, `profiles`, `secrets` |
| `cliutil.py` (+) | shared CLI output helpers: `profile(session)`, one `console` for every module |
| `text.py` | IBAN / text normalization shared by all modules |
| `paths.py` | per-user data dir (platformdirs, `CASHU_DATA_DIR`), legacy `data/` detection |
| `legacy.py` | `cashu migrate-data` (copy `data/` into the data dir with a backup) |
| `env.py` | `env()`: `CASHU_*` variables, `FINANSE_*` (legacy name) as a fallback |
| `migrate_legacy.py` | startup move of a pre-rename install (data dir, DB file, keychain, launchd) |
| `migrations/` | Alembic: `env.py` + `versions/` (0001 baseline = upstream schema, 0002 profiles, ...) |
| `security.py` | API token + Host check middleware, token meta tag |
| `i18n.py` | UI language of backend texts: `tr(pl=, en=)`, `X-Cashu-Lang` middleware, app language in `settings.json` ([localization.md](localization.md)) |
| `secrets.py` | OS keychain via keyring (`cashu secrets ...`) |
| `runtime.py` | source checkout vs packaged app: the command other programs run (launchd, MCP snippets), bundled skills, `bundle_replaced()` (an update replaced the app under a running process) |
| `worker/` | `cashu worker run|install|uninstall|status`: daily jobs for every profile, notifications, weekly digest, launchd agent (state + log in the data dir) |
| `events.py` | typed `change_events` written in the same transaction as ORM writes (session hooks; live data) |
| `live.py` | per-profile SSE change stream `GET /api/p/{slug}/changes/stream`, woken by `PRAGMA data_version` |
| `changes.py` (+) | change token of the database: the open app re-reads views after another process committed |
| `locks.py` (+) | named run locks shared by every process of one data dir (CLI, server, worker) |
| `mcp/` (+) | MCP server (`cashu mcp --profile <slug>`): `server.py`, `registry.py` (`ToolSpec`), `labels.py`, `redaction.py`, `audit.py`, `tools/<module>.py` |
| `agent_api.py`, `agent_models.py` (+) | agent layer API and tables: proposals, MCP call audit log, weekly reviews, MCP snippet |
| `proposals.py`, `reviews.py` (+) | agent proposals applied only on owner approval; weekly review records |
| `connectors/` (+) | owner-approved third-party connectors run out of process in a sandbox (manifest, protocol, runner, sandbox; `catalog.py` = the shipped community catalog `connectors/`) |
| `workspace/` (+) | per-profile agent workspace (managed CLAUDE.md, `.mcp.json`, permissions); `skills.py` holds `CORE_SKILLS` / `MODULE_SKILLS` |
| `uploads.py`, `types.py` (+) | size-capped multipart uploads of the local API; custom SQLAlchemy column types |

## `src/cashu/modules/`

| Path | Purpose |
|---|---|
| `budget/` | bank accounts, categorization, cashflow, recurring, cash pool |
| `budget/module.py` | `ModuleSpec` (router, CLI, cash net-worth contributor, setup) |
| `budget/models.py` | Transaction, CategoryRule, ImportBatch |
| `budget/service.py` | ingestion choke point, CSV import, `categorize_all` |
| `budget/cash.py` | the cash pool (one virtual account per currency and profile) |
| `budget/analytics.py` | cashflow, spending, drill-down, recurring payments |
| `budget/api.py`, `cli.py`, `setup.py`, `queries.py` | router, CLI commands, setup steps, queries |
| `budget/imports.py` | in-app statement import: preview (staged, read-only) -> commit |
| `budget/monthclose.py` | month close (`GET /budget/month-close`); `investing_link.py` reads the strategy's `contributions` |
| `budget/ingestion/` | normalize, dedup, transfers, `csv_import/` (per-bank parsers on `base.py`), `enable_banking/`, `canonical.py` (cashu-budget-import, `docs/budget-import-format.md`) |
| `budget/categorize/` | taxonomy (25 categories + ~420 PL rules), engine, rules, llm, local_llm, reclassify |
| `assets/` | manual positions, vehicles (`depreciation.py`), net-worth contributor |
| `loans/` | many loans per profile: `amortization.py`, `valuation.py`, `patterns.py`, api, cli |
| `investments/` | brokerage accounts, imports, portfolio, strategy + rules, signals (`cashu invest`) |
| `investments/domain/`, `portfolio/`, `market/`, `strategy/`, `rules/`, `importing/` | pure core (no DB, no IO) |
| `investments/models.py`, `store/` | `inv_*` tables and repositories |
| `investments/service/` | imports, daily check, strategy files, portfolio views, `prices.py`, `autorun.py` |
| `investments/module.py`, `api.py`, `cli.py`, `networth.py`, `setup.py` | spec, router, CLI, contributor, setup |
| `investments/live.py` | watched tables and list-row payloads for live data (pattern: `modules/<id>/live.py`) |
| `investments/alerts/`, `plan/`, `performance/`, `research/` (+) | dynamic alerts, recommendation checks, performance vs benchmark, sourced research notes and segments |
| `investments/perf_api.py`, `research_api.py` (+) | performance and research routes included into the investments router |

## `frontend/` (React + Vite + TS SPA; UI strings are Polish)

| Path | Purpose |
|---|---|
| `src/core/` | shell, profile switcher, wizard, settings, API client; `messages.ts` (Polish labels for backend codes), `live.ts` + `useLive.ts` |
| `src/modules/<id>/` | each module's tabs and its SetupPage |
| `src/widgets.tsx`, `grid.ts` | v2 widget grid on thirds (Grid, Widget, Facts, Hero, badges) |
| `src/charts.tsx`, `chart.ts` | v2 SVG charts (line + benchmark + levels, bars, donut, sparkline) |
| `src/ui.tsx`, `format.ts`, `index.css` | shared primitives and tokens |
| `src/i18n.ts`, `src/common.strings.ts`, `**/*.strings.ts` | UI language, `catalog({ key: { pl, en } })` text catalogs next to their code ([localization.md](localization.md)) |
| `src/core/api.ts`, `src/modules/<id>/api.ts` | typed API functions; `j` / `jpost` / `jdel` (in `core/api.ts`) send the token |
| `src/modules/investments/v2/priceRefresh.ts` | open-app quote refresh (on open and every 15 min) |
| `src/components/ScrollableChart.tsx` | window+scroll+axis+grid charts of the budget and loan pages |
| `e2e/` | Playwright smoke suite (see [running.md](running.md)) |

## Other top-level paths

| Path | Purpose |
|---|---|
| `docs/connectors.md` | connector contract for outside authors (manifest, protocol, sandbox); schemas in `docs/schemas/` |
| `docs/import-format.md`, `docs/budget-import-format.md` | cashU investments / budget import formats |
| `connectors/` | community connector catalog (contrib status, one dir per connector with `fixtures/`; shipped with the app, see its `README.md`) |
| `examples/connectors/` | three tested example connectors (budget CSV, investments JSON, fetch with a fixture) |
| `packaging/` | PyInstaller spec, entitlements, icon (macOS); `windows/` = documented stub; `README.md` = build decisions |
| `scripts/build_macos.sh` | builds cashU.app (SPA, icon, bundle; signs/notarizes from env vars; bundles Sparkle with `SPARKLE_PUBLIC_ED_KEY`) |
| `scripts/make_appcast.py` | signs a release archive for Sparkle and writes its update feed |
| `scripts/release_macos.sh` | the owner's local release: preflight, signed + notarized build of `origin/main`, update feed, GitHub release ([RELEASING.md](../../packaging/RELEASING.md)) |
| `scripts/fetch_sparkle.sh` | fetches the pinned Sparkle release (framework + signing tools) |
| `scripts/bump_version.py` | version bump run by `.github/workflows/bump-version.yml` on every push to `main` |
| `scripts/demo_data.py` | two synthetic demo profiles (see [running.md](running.md)) |
| `scripts/gen_connector_schemas.py` (+) | regenerates `docs/schemas/*.json` from the pydantic models (`--check` in tests) |
| `scripts/sync_skill_references.py` (+) | refreshes the reference copies inside `.claude/skills/*/references/` (`--check` in tests) |
| `scripts/render_research_prototype.py` | renders the headline-first research prototype (`scripts/prototypes/research_story.html`) with a profile's own data from the installed app, locally, into git-ignored `build/prototypes/` |
| `.claude/skills/` | the shipped product skills (see [skills.md](skills.md)) |
| `.claude/launch.json` | `dashboard` preview config (`cashu serve`) |
| `tests/` | pytest - synthetic data, no real data |
| `data/` | (git-ignored) legacy location of DB/keys/sessions (see `cashu migrate-data`) |
| `statements/` | (git-ignored) drop CSV statements here - empty in the repo |

## When to add a new entry

Add a row in the same change that adds a top-level file, package or script an agent would otherwise
not find. Remove rows for deleted paths: a stale row is worse than a missing one.
