# Data model - how the numbers work

What this is: the rules behind profiles, net worth, transfers, loans, cash, categorization, investments, live data and migrations, with the reason for each.

## What this pattern is

The domain rules every service, endpoint and test relies on. Code that breaks one of them produces
wrong totals on real data or leaks one profile's data into another.

## When this applies

Any change to a model, a service function, an analytics query, an API route or a migration in
`src/cashu/`. Paths below are relative to `src/cashu/` unless they start with `frontend/` or `tests/`.

## Rules

1. **Profiles scope everything.** A profile is a person or a household. Every account belongs to
   exactly one profile; learned category rules, import batches and Open Banking sessions are per
   profile too, the seed taxonomy is global. Transactions, balances, loans and depreciation belong to
   a profile through their account. Every service function takes `profile_id` (`None` = the default
   profile: `CASHU_PROFILE`, else the oldest). The API is `/api/p/{slug}/...`; the old `/api/...`
   paths are aliases for the default profile. The CLI takes `cashu --profile <slug> ...`.
   Why: data of one profile must never show up in another.
2. **Own IBANs are per profile.** "Own IBANs" (what counts as an internal transfer) are per profile:
   a transfer to a partner in another profile is a real outflow.
3. **Net worth is per-currency: never sum currencies.** Budget analytics default to the profile's base
   currency and take any other currency explicitly (the UI's currency picker lists the currencies with
   data: `GET /budget/currencies`). Core values every account from its balance snapshots; a module
   values the accounts it owns through its `NetWorthContributor` (loans, vehicles, cash pool). Sign,
   liquidity and chart bucket come from the account type registry. Why: a sum across currencies is a
   meaningless number.
4. **Internal transfers** (mBank<->Erste<->Pekao) are matched **by counterparty IBAN only** and are
   excluded from income/expenses. Why: names caused false positives.
5. **Illiquid accounts** (`property`, `vehicle`, `mortgage`, `loan`) count toward net worth but not
   toward "liquid". Liabilities subtract.
6. **Loans** (`Loan`, any number per profile): the net-worth balance = the computed outstanding debt
   (amortization), not a fixed number; `outstanding` returns 0 before origination. A balance recorded
   for the loan account *after* its terms were set (`cashu loans set-balance`, `set-balance`, a
   statement) wins from its date on, reduced by the principal repaid after it. Installments are
   recognised by phrases ("RATA KREDYTU", ...) and by each loan's lender account / title phrase
   (`cashu loans set-payment`), so they are "Raty kredytów", never subscriptions.
7. **Asset depreciation** (`Depreciation`): a car's value decays over time.
8. **Month close** (`modules/budget/monthclose.py`, `GET /budget/month-close`): income, spending and
   surplus of a month per currency (the cashflow filters), an optional cushion top-up (per-profile
   `profiles/<slug>/budget.json` in the data dir) and the suggested transfer, compared with the
   investments strategy's `contributions` when that module is on (read-only,
   `budget/investing_link.py`).
9. **Cash**: a virtual `manual`/`cash` account per currency and profile; its balance is the running
   sum of its transactions, not a snapshot. Tagging a bank withdrawal creates a mirror leg.
10. **Categorization** is a cascade; manual overrides (`manual_txn`) and LLM results (`llm_full`)
    survive re-categorization (`categorize_all` skips them). Why: the owner's corrections and the slow
    LLM pass must not be lost on a rerun.
11. **Investments** (`modules/investments/`): a brokerage account is a core account of type
    `brokerage`; transactions, renames, valuations, signals and the journal are per profile;
    instruments, price bars and FX rates are shared reference data. The math is the pure core (FIFO
    lots, valuation, allocation, rules); the `store/` and `service/` layers only load and persist.
    Files live in the data dir: `profiles/<slug>/strategy.yaml|.md` and
    `imports/<slug>/<sha256>.<ext>` (every committed import).
12. **Investment imports** go through the cashU format ([`docs/import-format.md`](../import-format.md)),
    a generic CSV mapping or an approved connector ([`docs/connectors.md`](../connectors.md)), never a
    broker-specific parser in the code base.
13. **Daily check and price refresh.** The daily check (`cashu invest run`) refreshes prices
    (Yahoo/stooq) and NBP rates without holding a database transaction across the network, then runs
    the rules per profile. Separately, the open app refreshes quotes on its own
    (`POST /investments/prices/refresh`, `service/prices.py`: Yahoo spark + one NBP table request, no
    rules, throttled to 10 min, skipped while the daily lock is held, off with
    `CASHU_PRICE_REFRESH=0`; on open and every 15 min from
    `frontend/src/modules/investments/v2/priceRefresh.ts`). The app server also runs the full daily
    check on its own (`service/autorun.py`: at start without a successful run today, then hourly after
    07:30; `CASHU_AUTO_DAILY=0` off, as in tests and the offline e2e server).
14. **Live data.** Every process records typed `change_events` in the same transaction as its ORM
    writes (`core/events.py` session hooks; a module lists its watched tables and list-row payloads in
    `modules/<id>/live.py`); the server pushes them per profile over SSE
    (`GET /api/p/{slug}/changes/stream`, `core/live.py`, woken by `PRAGMA data_version`) with a 60 s
    fallback poll (`GET /api/p/{slug}/changes`); the window patches cached lists in place and re-reads
    only the affected keys (`frontend/src/core/live.ts`, `useLive.ts`).
15. **Migrations: Alembic.** `init_db()` (every CLI command and server start) upgrades the DB to head;
    a pre-Alembic DB is stamped at `0001_baseline`. When you change a model, add a revision from the
    repo root (`CASHU_DATA_DIR=/tmp/x alembic revision --autogenerate -m "..."`) and use
    `op.batch_alter_table` for existing tables (SQLite rebuilds them). `tests/test_migrations.py`
    fails when models and migrations drift. Before a database with data is upgraded, a copy goes to
    `backups/` next to it (the legacy `data/finanse.db` (legacy name): to the data dir's `backups/`).
    `alembic upgrade` / `downgrade` from the repo root take the same copy first;
    `alembic -x no-backup=1 ...` skips it explicitly.

## How to apply

- New query or endpoint: take `profile_id` (or `profile: CurrentProfile` in a router) and filter every
  profile-scoped table by it, directly or through the account (rule 1).
- New account type or valued thing: register the type (sign, liquid, bucket) and value it through a
  `NetWorthContributor`, never by special-casing core (rule 3).
- New network fetch: never hold a database transaction across it (rule 13).
- Model change: revision + `batch_alter_table`, then `pytest tests/test_migrations.py` (rule 15).

## See also

- [conventions.md](conventions.md) - "What NOT to do" list that mirrors these rules
- [extending.md](extending.md) - adding a module, a bank, a dashboard feature, a migration
- [code-map.md](code-map.md) - where each file lives
