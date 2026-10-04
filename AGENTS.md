# AGENTS.md — guide for the AI agent working in this repo

This file is for the **agent** (Claude Code / any assistant) helping the user run
and extend the project. You walk the end user through setup following
[`ONBOARDING.md`](ONBOARDING.md) — this file is the code map and conventions.

---

## ⛔ Data-safety rules (most important)

This project works with the user's real financial data. **Never** leak data into
the repository or off the machine:

1. **Never commit data.** These never go into git: `data/**` (DB, backups, keys,
   sessions), `statements/**` (CSVs), `.env`, `*.pem`. They are all in
   `.gitignore`. Before every commit, run `git status` — if you see a data file
   staged, **stop and report it to the user**. The DB, Open Banking sessions and
   key, backups and the API token now live in the per-user data dir outside the
   repo (`core/paths.py`); `data/` only holds them in older checkouts until
   `finanse migrate-data`. Tests always set `FINANSE_DATA_DIR` to a temp dir.
2. **Never write balances, IBANs, names, or transactions** into files that could
   land in the repo (code, tests, docs). Tests use synthetic data.
3. **Never send data to a cloud LLM.** The `anthropic` backend sends only the
   merchant-name string — never IBANs, balances, or names. The default backend
   is local `ollama` (offline). Don't change this without the user's explicit OK.
4. **Bank credentials (login/password/SCA) are entered only by the user** in the
   bank's browser. The code never sees them and must never ask for them.

---

## Language convention

The codebase is English (comments, docstrings, CLI help, docs). Two things are
**intentionally Polish and must stay Polish** — they are domain data, not code
language:

- **Dashboard UI strings** in `frontend/` (tab names, buttons, labels) and the
  category display labels — the tool targets Polish-bank users.
- **Matching data**: CSV column headers detected in the parsers
  (`#Data operacji`, `Rachunek źródłowy`, …), the ~420 PL keyword rules in
  `modules/budget/categorize/taxonomy.py`, the installment phrases in
  `modules/loans/patterns.py`, the patterns in `engine.py`/`reclassify.py`, and
  the LLM prompts in `local_llm.py`/`reclassify.py`. These are matched against Polish
  bank transaction text — translating them breaks categorization on real data.

Rule of thumb: if a string is **explanation for a developer** → English. If it is
**data** (matched, shown to the user, or sent to the LLM as a prompt/enum) → leave
it Polish.

---

## What the project is

A local personal-finance tracker. It pulls transactions from Polish banks
(**mBank**, **Erste** / former Santander, **Pekao**) via CSV export and optionally
Open Banking (Enable Banking), normalizes them to a common model, deduplicates,
detects internal transfers between the user's own accounts, categorizes spending,
and computes net worth, monthly cashflow, and recurring payments. Data is kept
per **profile** (a person or a household), and features come in **modules**
(budget, assets, loans, investments) chosen per profile. The dashboard is
FastAPI + a React SPA. Everything runs **locally**.

Stack: Python 3.12+, SQLModel/SQLite, Typer (CLI), FastAPI (API),
React + Vite + TypeScript + Recharts (frontend).

---

## Repository map

The app is a **core** plus **modules**. Core is always on (profiles, accounts,
balances, net worth, registries, data dir, migrations, local API security); each
module owns its tables, API router, CLI commands and blank-page setup steps and
registers them with a `ModuleSpec`. A module never imports another module's
internals: cross-module needs go through core (net-worth contributors, account
types, institutions, categorization hooks).

```
src/finanse/
├── cli.py            # Typer root: --profile, core + module commands, `stats` (entry point)
├── config.py         # Settings (pydantic-settings), reads .env (FINANSE_ prefix)
├── models.py         # facade: every table (scripts, Alembic env)
├── db.py             # alias of core/db.py (`finanse.db.engine` still works)
├── core/
│   ├── db.py             # SQLite engine + pragmas (WAL, busy_timeout, foreign_keys), init_db
│   ├── models.py         # Profile, ProfileModule, Account, Balance (+ AccountType, Source)
│   ├── profiles.py       # profiles, slugs, the default profile, module choice per profile
│   ├── modules.py        # ModuleSpec + registry (finanse/modules/<id>/module.py)
│   ├── account_types.py  # account type registry: sign, liquid, net-worth bucket, PL label
│   ├── institutions.py   # bank/broker registry: CSV importer, Open Banking ASPSP names
│   ├── accounts.py       # get_or_create_account, balances, own IBANs (per profile)
│   ├── networth.py       # net worth per currency from module NetWorthContributors
│   ├── api.py            # profile resolution, /api/system|modules|profiles, accounts, net worth
│   ├── cli.py            # init-db, serve, migrate-data, accounts, set-balance, profiles, secrets
│   ├── text.py           # IBAN / text normalization shared by all modules
│   ├── paths.py          # per-user data dir (platformdirs, FINANSE_DATA_DIR), legacy data/ detection
│   ├── legacy.py         # `finanse migrate-data` (copy data/ into the data dir with a backup)
│   ├── migrations/       # Alembic: env.py + versions/ (0001 baseline = upstream schema, 0002 profiles, ...)
│   ├── security.py       # API token + Host check middleware, token meta tag
│   └── secrets.py        # OS keychain via keyring (`finanse secrets ...`)
├── modules/
│   ├── budget/           # bank accounts, categorization, cashflow, recurring, cash pool
│   │   ├── module.py         # ModuleSpec (router, CLI, cash net-worth contributor, setup)
│   │   ├── models.py         # Transaction, CategoryRule, ImportBatch
│   │   ├── service.py        # ingestion choke point, CSV import, categorize_all
│   │   ├── cash.py           # the cash pool (one virtual account per currency and profile)
│   │   ├── analytics.py      # cashflow, spending, drill-down, recurring payments
│   │   ├── api.py, cli.py, setup.py, queries.py
│   │   ├── ingestion/        # normalize, dedup, transfers, csv_import/ (per-bank parsers), enable_banking/
│   │   └── categorize/       # taxonomy (25 categories + ~420 PL rules), engine, rules, llm, local_llm, reclassify
│   ├── assets/           # manual positions, vehicles (depreciation.py), net-worth contributor
│   ├── loans/            # many loans per profile: amortization.py, valuation.py, patterns.py, api, cli
│   └── investments/      # in progress (port of Kompas); listed in the wizard until its module.py lands
└── api/
    ├── app.py            # FastAPI composition: /api/p/{slug}/... + legacy /api/... aliases, SPA
    ├── static/index.html # legacy fallback (when webdist/ is absent)
    └── webdist/          # built React SPA (git-ignored, `npm run build`)

frontend/                 # React + Vite + TS SPA (dashboard; UI strings are Polish)
├── src/core/             # shell, profile switcher, wizard, settings, API client
├── src/modules/<id>/     # each module's tabs and its SetupPage
└── src/ui.tsx, format.ts, index.css   # shared primitives and tokens

tests/                    # pytest — synthetic data, no real data
data/                     # (git-ignored) legacy location of DB/keys/sessions (see migrate-data)
statements/               # (git-ignored) drop CSV statements here — empty in the repo
```

---

## Running and verifying

```bash
# environment
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
finanse init-db

# tests (synthetic data — safe)
pytest

# dashboard: backend + built frontend
cd frontend && npm install && npm run build && cd ..
finanse serve                      # http://127.0.0.1:8500

# dashboard in dev mode (HMR): two processes
finanse serve                      # terminal 1 (API :8500)
cd frontend && npm run dev         # terminal 2 (Vite :5173, proxies /api → :8500)
```

There is a `.claude/launch.json` with a `dashboard` config — via the preview
tools you can run `finanse serve` and verify changes in the browser (net worth,
charts, tabs). `webdist/` is git-ignored — after `git clone` you must run
`npm run build` once, otherwise FastAPI falls back to the legacy
`static/index.html`.

---

## Data model / how the numbers work

- **Profiles.** A profile is a person or a household. Every account belongs to
  exactly one profile; learned category rules, import batches and Open Banking
  sessions are per profile too, the seed taxonomy is global. Transactions,
  balances, loans and depreciation belong to a profile through their account.
  Every service function takes `profile_id` (`None` = the default profile:
  `FINANSE_PROFILE`, else the oldest). The API is `/api/p/{slug}/...`; the old
  `/api/...` paths are aliases for the default profile. The CLI takes
  `finanse --profile <slug> ...`. "Own IBANs" (what counts as an internal
  transfer) are per profile: a transfer to a partner in another profile is a real
  outflow.
- **Net worth is per-currency** — never sum currencies. Analytics default to PLN.
  Core values every account from its balance snapshots; a module values the
  accounts it owns through its `NetWorthContributor` (loans, vehicles, cash pool).
  Sign, liquidity and chart bucket come from the account type registry.
- **Internal transfers** (mBank↔Erste↔Pekao) are matched **by counterparty IBAN
  only** (names caused false positives). Excluded from income/expenses.
- **Illiquid accounts** (`property`, `vehicle`, `mortgage`, `loan`) count toward
  net worth but not toward "liquid". Liabilities subtract.
- **Loans** (`Loan`, any number per profile): the net-worth balance = the computed
  outstanding debt (amortization), not a fixed number; `outstanding` returns 0
  before origination. A balance recorded for the loan account *after* its terms
  were set (`finanse loans set-balance`, `set-balance`, a statement) wins from its
  date on, reduced by the principal repaid after it. Installments are recognised
  by phrases ("RATA KREDYTU", ...) and by each loan's lender account / title phrase
  (`finanse loans set-payment`), so they are "Raty kredytów", never subscriptions.
- **Asset depreciation** (`Depreciation`): a car's value decays over time.
- **Cash**: a virtual `manual`/`cash` account per currency and profile; its balance
  is the running sum of its transactions, not a snapshot. Tagging a bank
  withdrawal creates a mirror leg.
- **Categorization** is a cascade; manual overrides (`manual_txn`) and LLM results
  (`llm_full`) survive re-categorization (`categorize_all` skips them).
- **Migrations: Alembic.** `init_db()` (every CLI command and server start)
  upgrades the DB to head; a pre-Alembic DB is stamped at `0001_baseline`. When
  you change a model, add a revision from the repo root
  (`FINANSE_DATA_DIR=/tmp/x alembic revision --autogenerate -m "..."`) and use
  `op.batch_alter_table` for existing tables (SQLite rebuilds them).
  `tests/test_migrations.py` fails when models and migrations drift. Before a
  database with data is upgraded, a copy goes to `backups/` next to it (the
  legacy `data/finanse.db`: to the data dir's `backups/`). `alembic upgrade` /
  `downgrade` from the repo root take the same copy first; `alembic -x
  no-backup=1 ...` skips it explicitly.

---

## Conventions when extending

**Adding a new bank (CSV parser):**
1. New file `src/finanse/modules/budget/ingestion/csv_import/<bank>.py` - a thin
   config on top of the engine in `base.py` (model it on `mbank.py`/`pekao.py`:
   encoding, separator, columns, where currency/IBAN/balance come from; set
   `bank = "<id>"`). Keep the bank's Polish CSV headers verbatim - they are
   matched against the file.
2. Add one `Institution` entry to `BUILTIN` in `core/institutions.py`: id, kind
   `bank`, display name, `csv_importer="<module path>:<Class>"` and the
   `aspsp_patterns` that map its Enable Banking ASPSP name. Import, auto-detection,
   `--bank` choices and `statements/<id>/` directories pick it up from there.
3. Add a test in `tests/test_parsing.py` using a **synthetic** sample of the format.

**Adding a module:** a package `src/finanse/modules/<id>/` with its tables
(`models.py`, plus an Alembic revision), and `module.py` exporting
`MODULE = ModuleSpec(...)`: Polish name/description (wizard), router, CLI
`register`, optional `NetWorthContributor`, account types / buckets /
institutions it owns, categorization hooks, `setup_status(session, profile_id)`
(blank-page steps) and its setup skill. Add the id to `MODULE_IDS` in
`core/modules.py`. Never import another module's internals.

**Adding a dashboard feature:**
1. Endpoint in the module's `api.py` router (plain JSON). Take the profile with a
   `profile: CurrentProfile` parameter and pass `profile_id=profile.id` to every
   query; the app mounts module routers under `/api/p/{slug}/...` and as legacy
   `/api/...` aliases. Add the route to `PROFILE_GETS` in
   `tests/test_profiles.py` (a guard test fails otherwise): it checks that two
   profiles never see each other's data. Every `/api/*` route is behind the
   token + Host check automatically (`core/security.py`); in tests use a
   `TestClient` with `base_url=security.get_config().base_url` and the
   `X-Finanse-Token` header (see `tests/conftest.py`).
2. Type + function in `frontend/src/api.ts` (mirror the JSON shape); call it
   through `j`/`jpost`/`jdel`, which send the token.
3. Component in `frontend/src/components/` or a new tab in `frontend/src/tabs/`
   (UI strings stay Polish).
4. Line/bar charts: use `components/ScrollableChart.tsx` (window+scroll+axis
   +grid). Don't add zoom/pan plugins to Chart.js — they were removed as janky.

**CLI:** a module's commands live in its `cli.py` and are added by `register(app)`
(top level, upstream names) and in the module's sub-app (`finanse loans ...`).
Resolve the profile with `core.cliutil.profile(session)` and print through
`core.cliutil.console`. Follow the existing pattern.

**Tests:** `pytest`. Always synthetic data. Never paste real statements. Point
`FINANSE_DATA_DIR` at a temp dir (never the real data dir) and use an in-memory
keyring backend for secrets. `conftest.seed_demo(session, profile_id=...)` seeds a
synthetic household into any profile; `tests/upstream_db.py` builds an
upstream-shaped database for migration tests.

---

## What NOT to do

- Don't sum different currencies into a single net-worth figure.
- Don't match internal transfers by name/amount — IBAN only.
- Don't run `eb resync` / `reclassify` in a loop — banks throttle PSD2 (429), and
  the local LLM is slow. Sync ~once a day.
- Don't overwrite an existing account's type, or its name with the owner name from OB.
- Don't query a profile-scoped table without the profile (accounts, rules,
  transactions through their account): data of one profile must never show up in
  another.
- Don't commit anything from `data/` or `statements/`.
