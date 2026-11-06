# Data model - how the numbers work

What this is: the rules behind profiles, net worth, transfers, loans, cash, categorization, investments, live data and store schema evolution, with the reason for each.

## What this pattern is

The domain rules every module, query, command, MCP tool and test relies on. Code that breaks one of
them produces wrong totals on real data or leaks one profile's data into another.

## When this applies

Any change to an event, a view, a query, a command, a domain calculation or an MCP tool. The pure
rules live in `packages/domain/src/`, their persistence in `packages/store/src/` (paths below are
relative to those unless they start with `apps/` or `packages/`).

## Rules

1. **Profiles scope everything: one vault per profile.** A profile is a person or a household and is
   its own encrypted vault (`<data dir>/stores/vaults/<id>.db`, key in the OS keychain, a 24-word
   recovery phrase made at creation). Events carry no profile id: the vault is the boundary, and
   opening a database that belongs to another vault is refused (`packages/store/src/materialize.ts`).
   Seed data (taxonomy, institutions) is code; learned category rules, imports, Open Banking sessions
   and connector approvals belong to the vault. The CLI takes `cashu --profile <slug> ...` (else
   `CASHU_PROFILE`, else the oldest profile); an MCP session serves exactly one vault and refuses an
   ambiguous slug. Why: data of one profile must never show up in another
   (`packages/store/src/investments/queries/isolation.test.ts`).
2. **Own IBANs are per profile.** "Own IBANs" (what counts as an internal transfer) are the vault's
   accounts: a transfer to a partner in another profile is a real outflow.
3. **Net worth is per-currency: never sum currencies.** Budget analytics default to the profile's base
   currency and take any other currency explicitly. Core values every account from its balance
   snapshots (`core/networth.ts`, `core/valuation.ts`); a module values the accounts it owns through
   its `NetWorthContributor` (`<module>/networth.ts`: loans, vehicles, cash pool, brokerage), plugged
   into the store through `StoreModule.netWorth`. Sign, liquidity and chart bucket come from the
   account type registry (`core/accountTypes.ts`). Why: a sum across currencies is a meaningless
   number.
4. **Internal transfers** (mBank<->Erste<->Pekao) are matched **by counterparty IBAN only**
   (`budget/transfers.ts`) and are excluded from income/expenses. Why: names caused false positives.
5. **Illiquid accounts** (`property`, `vehicle`, `mortgage`, `loan`) count toward net worth but not
   toward "liquid". Liabilities subtract.
6. **Loans** (any number per profile, `loans/`): the net-worth balance = the computed outstanding debt
   (amortization), not a fixed number; outstanding is 0 before origination. A balance recorded for the
   loan account *after* its terms were set (`cashu loans set-balance`, `cashu set-balance`, a statement)
   wins from its date on, reduced by the principal repaid after it. Installments are recognised by
   phrases ("RATA KREDYTU", ... in `loans/patterns.ts`) and by each loan's lender account / title
   phrase (`cashu loans set-payment`), so they are "Raty kredytów", never subscriptions.
7. **Asset depreciation** (`assets/depreciation.ts`): a car's value decays over time down to its floor.
8. **Month close** (`budget/analytics/monthClose.ts`, `cashu budget month-close`, the budget screen):
   income, spending and surplus of a month per currency (the cashflow filters), an optional cushion
   top-up (`cashu budget cushion`) and the suggested transfer, compared with the investments
   strategy's `contributions` when that module is on (read-only).
9. **Cash** (`budget/cash.ts`): a virtual cash account per currency and profile; its balance is the
   running sum of its transactions, not a snapshot. Tagging a bank withdrawal creates a mirror leg.
10. **Categorization** is a cascade (`budget/categorize/`): manual overrides and LLM results survive
    re-categorization. Why: the owner's corrections and the slow LLM pass must not be lost on a rerun.
11. **Investments** (`investments/`): a brokerage account is a core account of type `brokerage`;
    transactions, renames, valuations, signals and the journal are per vault; instruments, price bars
    and FX rates are shared reference data (the device's price cache). The math is the pure core in
    `packages/domain/src/investments/` (FIFO lots, valuation, allocation, rules); the store only
    loads and persists. Strategy documents (`strategy.md` + optional `strategy.yaml`) live in the
    vault's private directory (`apps/host/src/nativeStrategyDocuments.ts`; design note
    [strategies.md](strategies.md)).
12. **Investment imports** go through the cashU format ([`docs/import-format.md`](../import-format.md)),
    a generic CSV mapping or an approved connector ([`docs/connectors.md`](../connectors.md)), never a
    broker-specific parser in the code base.
13. **Daily check and price refresh.** The host's worker (`apps/host/src/worker/`) runs the daily
    jobs once a day (default 07:30, no replay of missed days): connector fetches, the investments
    daily check (prices from Yahoo/stooq, NBP rates, then the rules per vault; also
    `cashu invest run`), the budget bank sync, notifications and the weekly digest. While a window is
    open it also refreshes quotes every 5 minutes (no rules). A network fetch never holds a store
    transaction open.
14. **Live data.** Every applied event reports the views it touched to the store's change hub
    (`packages/store/src/subscribe.ts`); the host pushes a live query to the window when its encoded
    value changes (`apps/host/src/storeChannel.ts`), and the renderer reads through `useQuery`
    (`packages/store-react`). Writes go through commands and the host's write queue. A value that is
    not in the store (worker status, updater status) is a query with a `changes` source its owner
    fires (`ChangeSource` in `packages/store/src/query.ts`); OS facts without a change event are
    re-checked by Electron main and pushed. The renderer never polls, refetches or re-reads on focus
    (guard `tools/arch/src/guards/liveData.ts`). Design:
    `tools/claude-dev/skills/cashu-ts-architecture/references/data-flow.md`.
15. **Store schema evolution: events are forever, views are rebuilt.** Stored events never change.
    An optional event field whose absence keeps the old meaning can keep its version; any other change
    bumps the event's `v` and registers an upcaster (`packages/store/src/upcast.ts`, `upcastFrom` in
    the module's `EventVersionDef`); a type name is never reused. A view change bumps the
    materializer's or deriver's `version` (or changes its table DDL): on the next open the store
    compares fingerprints and rebuilds only what changed from the log, in one transaction
    (`rebuild.ts`). There are no SQL migrations. Spec: `packages/store/spec/events.md` section 7; the
    catalog test (`events/v1/catalog.test.ts`) keeps the code and the spec in step; guards:
    `upgrade.test.ts`, `view-upgrade.test.ts`. Data of the old Python app comes over once, through
    `cashu migrate` ([migration-runbook.md](../migration-runbook.md)).

## How to apply

- New query or command: run it on one vault, never across vaults (rule 1); an MCP tool gets its vault
  from the session, never from an argument.
- New account type or valued thing: register the type (sign, liquid, bucket) and value it through a
  `NetWorthContributor`, never by special-casing core (rule 3).
- New network fetch: never hold a store transaction across it (rule 13).
- Event or view change: version + upcaster or view version bump, update `events.md`, then run the
  store tests (`pnpm --filter @cashu/store test`) (rule 15).

## See also

- [conventions.md](conventions.md) - "What NOT to do" list that mirrors these rules
- [extending.md](extending.md) - adding a module, a screen, an MCP tool, a store schema change
- [code-map.md](code-map.md) - where each file lives
