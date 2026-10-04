# finanse — a local personal-finance tracker

Pulls transactions from Polish banks (**mBank**, **Erste** / former Santander,
**Pekao**) via CSV export and optionally Open Banking, normalizes them to a common
model, deduplicates, detects internal transfers between your own accounts,
categorizes spending, and shows **net worth over time, monthly cashflow, recurring
payments, loans, and asset depreciation** on a web dashboard. Data is kept per
**profile** (you, your partner, the household), and each profile picks the
**modules** it uses (budget, assets, loans; investments in progress).

> 🔒 **Privacy.** Everything runs **locally**. Your financial data lives in a
> SQLite file in your per-user data dir, outside the repository
> (`~/Library/Application Support/finanse` on macOS, `%APPDATA%\finanse` on
> Windows, `~/.local/share/finanse` on Linux; override with `FINANSE_DATA_DIR`),
> so it **never lands in the repository** (statements and `.env` are git-ignored
> too). API keys go to the OS keychain (`finanse secrets set anthropic`). The
> dashboard listens on `127.0.0.1` only and every API call needs a per-launch
> token. Bank passwords never pass through this code - you log in (SCA) yourself
> in the bank's browser. Categorization uses a local offline model by default; the
> optional cloud mode sends **only merchant names**.

> 🌐 **Language.** Code, comments, and docs are in English. The **dashboard UI is
> in Polish** and so are the categorization keywords and LLM prompts — the tool
> targets customers of Polish banks, and those strings are matched against Polish
> transaction text.

Stack: Python 3.12+ · SQLModel/SQLite · Typer (CLI) · FastAPI (API) ·
React + Vite + TypeScript + Recharts (dashboard).

---

## 🚀 Fastest start — with an AI agent

The project is set up so an **agent (e.g. Claude Code) walks you through the whole
setup step by step** — from install, through loading your data, to running the
dashboard.

```bash
git clone <repo-url> finanse && cd finanse
```

Open the directory in Claude Code (or another file-aware assistant) and say:

> **"Walk me through the setup following ONBOARDING.md."**

The agent reads [`ONBOARDING.md`](ONBOARDING.md), [`AGENTS.md`](AGENTS.md), and
[`CLAUDE.md`](CLAUDE.md), then runs the steps with you, asking questions where a
decision is needed (CSV import or Open Banking, which categorization model, etc.).
The agent knows the safety rules and **won't commit your data**.

---

## 🔧 Manual start (no agent)

```bash
# 1) environment
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"       # exact tested versions: add -c constraints.txt
finanse init-db                # prints where the database lives
cp .env.example .env         # the defaults are enough to start

# 2) drop CSV statements into statements/<bank>/ (mbank | erste | pekao), then:
finanse import-dir statements  # bank from the subdir name, idempotent
                               # (the first import creates the "default" profile)
finanse match-transfers        # pair internal transfers (by IBAN)
finanse categorize             # categories (PL rules; --llm for the tail)

# 3) dashboard
cd frontend && npm install && npm run build && cd ..
finanse serve                  # http://127.0.0.1:8500
```

Full guide (including Open Banking, LLM categorization, manual positions) —
[`ONBOARDING.md`](ONBOARDING.md).

**More than one person?** `finanse profiles add "Marta"` creates a second
profile; run commands for it with `finanse --profile marta ...` (or set
`FINANSE_PROFILE`), and switch profiles in the dashboard header.

**Upgrading from a version that kept the database in `data/`?** finanse keeps
using it and says so on every command until you run `finanse migrate-data`, which
copies the database (plus Open Banking sessions and key) into the data dir with a
timestamped backup and leaves the originals untouched. An existing database is
upgraded automatically (with a backup in `backups/` first): all its data becomes
the `default` profile, with the modules it already uses switched on.

---

## What it does

- **Net worth over time** — per-currency (never mixes currencies), broken down by
  asset/liability class (cash, property, vehicle, mortgage, loan), with a
  windowed/scrollable chart and a zoomable Y axis.
- **Monthly cashflow** — income vs expenses, excluding transfers within your own
  net worth.
- **Where the money goes** - spending categorization (25 categories, ~420 PL rules
  + optional LLM), drill-down to transactions with corrections that teach the
  system.
- **Recurring payments** — subscription detection.
- **Loans** - any number per profile; annuity amortization (payment, schedule,
  outstanding debt, total interest); the net-worth balance decreases over time,
  and a balance from a bank statement takes over from its date. Installments are
  recognised as loan repayments, never as subscriptions.
- **Assets and cash** — car depreciation, manual positions, cash tracking.

The dashboard has 5 tabs: **Przegląd · Wydatki · Przepływy · Subskrypcje · Kredyt**
(the UI is in Polish).

---

## Where the data comes from

**CSV import (works right away, no API).** Arrange statements under
`statements/<bank>/` — import takes the bank from the subdir name. Repeated import
is idempotent (dedup by `bank_transaction_id` and by content hash). Parsers are
thin configs on a shared engine (`src/finanse/modules/budget/ingestion/csv_import/`)
and banks are entries in a registry (`src/finanse/core/institutions.py`) -
**adding another bank is easy** (see [`AGENTS.md`](AGENTS.md)).

**Open Banking (Enable Banking, optional).** A free "Restricted Production" tier
for live sync (~90 days, re-authorize every 90 days). The hybrid is deliberate: OB
keeps data current, and you backfill history with CSV exports. Step-by-step config
in [`ONBOARDING.md`](ONBOARDING.md).

---

## Data model

| table | role |
|---|---|
| `profiles`, `profile_modules` | profiles (person / household) and the modules each one uses |
| `accounts` | accounts of a profile (one physical account = one record; Santander and Erste are the same account) |
| `transactions` | normalized signed transactions (+income / −expense), with a dedup hash and transfer group |
| `balances` | balance snapshots over time — the basis for net worth |
| `category_rules` | learned merchant → category rules (per profile) |
| `import_batches` | audit of every import/sync |

Plus the `Loan` (loan amortization, many per profile) and `Depreciation` (asset
depreciation) models. Schema changes are Alembic migrations
(`src/finanse/core/migrations/`).

---

## Development and tests

```bash
pytest                               # tests run on synthetic data
cd frontend && npm run dev           # dashboard with hot-reload (proxies /api → :8500)
```

Architecture, code map, conventions, and "how to add a bank / feature" —
[`AGENTS.md`](AGENTS.md).

---

## Disclaimers

A personal-use tool, provided "as is" (licensed [MIT](LICENSE)). Not financial or
investment advice. CSV formats and Open Banking endpoints drift — an unusual
statement may need a small parser tweak (an agent can handle it from a sample file).
