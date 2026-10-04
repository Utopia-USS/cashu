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
  `categorize/taxonomy.py`, the patterns in `engine.py`/`reclassify.py`, and the
  LLM prompts in `local_llm.py`/`reclassify.py`. These are matched against Polish
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
and computes net worth, monthly cashflow, and recurring payments. The dashboard is
FastAPI + a React SPA. Everything runs **locally**.

Stack: Python 3.12+, SQLModel/SQLite, Typer (CLI), FastAPI (API),
React + Vite + TypeScript + Recharts (frontend).

---

## Repository map

```
src/finanse/
├── cli.py            # Typer CLI — all `finanse ...` commands (entry point)
├── config.py         # Settings (pydantic-settings), reads .env (FINANSE_ prefix)
├── db.py             # SQLite engine + pragmas (WAL, busy_timeout, foreign_keys), init_db
├── core/
│   ├── paths.py          # per-user data dir (platformdirs, FINANSE_DATA_DIR), legacy data/ detection
│   ├── legacy.py         # `finanse migrate-data` (copy data/ into the data dir with a backup)
│   ├── migrations/       # Alembic: env.py + versions/ (0001_baseline = upstream schema)
│   ├── security.py       # API token + Host check middleware, token meta tag
│   └── secrets.py        # OS keychain via keyring (`finanse secrets ...`)
├── models.py         # SQLModel: Account, Transaction, Balance, Loan, Depreciation, ...
├── types.py          # enums: Bank, AccountType, ...
├── service.py        # domain logic: import, accounts, balances, categories, cash, loan
├── analytics.py      # net worth (+ components), cashflow, spending, recurring, cash
├── loan.py           # annuity amortization (payment, schedule, outstanding)
├── depreciation.py   # asset depreciation (declining balance, e.g. a car)
├── ingestion/
│   ├── normalize.py      # RawTransaction, IBAN normalization (iban_key)
│   ├── dedup.py          # deduplication (bank_transaction_id + content hash)
│   ├── transfers.py      # internal-transfer matching (IBAN only)
│   ├── csv_import/       # per-bank CSV parsers (base.py = engine, {mbank,erste,pekao}.py)
│   └── enable_banking/   # Open Banking client, sync, callback, state (sessions)
├── categorize/
│   ├── taxonomy.py       # 23 categories + ~420 PL rules (apply_seed_rules)
│   ├── engine.py         # categorization cascade (transfer→rule→seed→subscription→...)
│   ├── rules.py          # learned rules merchant_key→category (CategoryRule)
│   ├── llm.py            # anthropic backend (Claude Haiku) — merchant string only
│   ├── local_llm.py      # ollama backend (offline)
│   └── reclassify.py     # per-transaction reclassification with full context
└── api/
    ├── app.py            # FastAPI: /api/* JSON + serves the frontend from webdist/
    ├── static/index.html # legacy fallback (when webdist/ is absent)
    └── webdist/          # built React SPA (git-ignored, `npm run build`)

frontend/                 # React + Vite + TS SPA (dashboard; UI strings are Polish)
├── src/api.ts            # typed client + response shapes (mirror the backend)
├── src/hooks.ts          # useAsync (fetch+reload), useWidth (callback-ref + ResizeObserver)
├── src/format.ts         # currency/date formatters, palette, CSS-var reader
├── src/ui.tsx            # Seg, Kpi, skeletons (Skeleton, SkeletonChart, ...)
├── src/tabs/*            # one component per tab: Overview, Expenses, Flows, Subscriptions, Loan
└── src/components/*      # charts and cards: NetWorthChart, ScrollableChart, SpendingDonut, CashCard, Accounts, Breakdown

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

- **Net worth is per-currency** — never sum currencies. Analytics default to PLN.
- **Internal transfers** (mBank↔Erste↔Pekao) are matched **by counterparty IBAN
  only** (names caused false positives). Excluded from income/expenses.
- **Illiquid accounts** (`property`, `vehicle`, `mortgage`, `loan`) count toward
  net worth but not toward "liquid". Liabilities subtract.
- **Loans** (`Loan`): the net-worth balance = the computed outstanding debt today
  (amortization), not a fixed number. `outstanding` returns 0 before origination.
- **Asset depreciation** (`Depreciation`): a car's value decays over time.
- **Cash**: a virtual `Bank.MANUAL`/`CASH` account; its balance is the running sum
  of its transactions, not a snapshot. Tagging a bank withdrawal creates a mirror leg.
- **Categorization** is a cascade; manual overrides (`manual_txn`) and LLM results
  (`llm_full`) survive re-categorization (`categorize_all` skips them).
- **Migrations: Alembic.** `init_db()` (every CLI command and server start)
  upgrades the DB to head; a pre-Alembic DB is stamped at `0001_baseline`. When
  you change a model, add a revision from the repo root
  (`FINANSE_DATA_DIR=/tmp/x alembic revision --autogenerate -m "..."`) and use
  `op.batch_alter_table` for existing tables (SQLite rebuilds them).
  `tests/test_migrations.py` fails when models and migrations drift.

---

## Conventions when extending

**Adding a new bank (CSV parser):**
1. New file `src/finanse/ingestion/csv_import/<bank>.py` — a thin config on top of
   the engine in `base.py` (model it on `mbank.py`/`pekao.py`: encoding, separator,
   columns, where currency/IBAN/balance come from). Keep the bank's Polish CSV
   headers verbatim — they are matched against the file.
2. Add a value to the `Bank` enum in `types.py`.
3. Register the parser where import picks it by bank name (see `import-dir` /
   `import-csv` in `service.py`/`cli.py`).
4. Add a test in `tests/test_parsing.py` using a **synthetic** sample of the format.

**Adding a dashboard feature:**
1. Endpoint in `api/app.py` (plain JSON under `/api/...`). Every `/api/*` route
   is behind the token + Host check automatically (`core/security.py`); in tests
   use a `TestClient` with `base_url=security.get_config().base_url` and the
   `X-Finanse-Token` header (see `tests/conftest.py`).
2. Type + function in `frontend/src/api.ts` (mirror the JSON shape); call it
   through `j`/`jpost`/`jdel`, which send the token.
3. Component in `frontend/src/components/` or a new tab in `frontend/src/tabs/`
   (UI strings stay Polish).
4. Line/bar charts: use `components/ScrollableChart.tsx` (window+scroll+axis
   +grid). Don't add zoom/pan plugins to Chart.js — they were removed as janky.

**CLI:** commands are `@app.command(...)` in `cli.py`. Follow the existing pattern.

**Tests:** `pytest`. Always synthetic data. Never paste real statements. Point
`FINANSE_DATA_DIR` at a temp dir (never the real data dir) and use an in-memory
keyring backend for secrets.

---

## What NOT to do

- Don't sum different currencies into a single net-worth figure.
- Don't match internal transfers by name/amount — IBAN only.
- Don't run `eb resync` / `reclassify` in a loop — banks throttle PSD2 (429), and
  the local LLM is slow. Sync ~once a day.
- Don't overwrite an existing account's type, or its name with the owner name from OB.
- Don't commit anything from `data/` or `statements/`.
