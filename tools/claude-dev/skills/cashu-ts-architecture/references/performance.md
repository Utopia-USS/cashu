---
title: Performance budgets
impact: HIGH
tags: performance, budgets, virtualization, react-compiler, startup
---

# Performance budgets

Proposed numbers (S51, to be confirmed by the first measurements on real hardware; the physical
iPhone / Android runs belong to S41g, so far only the iOS simulator and an M-series Mac have measured).
Reference devices: iPhone 13 class for mobile, an M1 MacBook Air for desktop. Data: the 60k-transaction synthetic
profile. A change that breaks a budget needs a measurement and the lead's OK, not a new number.

| Budget | Target |
|---|---|
| Mobile cold start to first data on screen (snapshot present) | p50 <= 1.5 s, p95 <= 2.5 s |
| Desktop window shown to first data | <= 1.0 s after the local host is ready |
| Snapshot load (mobile) / full rebuild from the log | <= 0.5 s / <= 10 s desktop, <= 30 s mobile in the background |
| Store apply (lead, 2026-10-31): first sync / genesis of ~5 years (~64k events) / a day's events / rebuild after an upgrade | desktop <= 10 s, phone <= 30 s with progress / <= 100 ms / desktop <= 3 s; measured on an idle machine |
| One live query on a UI-facing thread | <= 8 ms per run (half a 60 Hz frame); slower moves to a derived table or off-thread |
| Local command to updated UI | p95 <= 50 ms (no perceptible lag below 100 ms) |
| Tap / click to visual response | <= 100 ms |
| Scrolling the 60k list | no dropped frames > 1% in a 10 s fling at 60 Hz (120 Hz on ProMotion) |
| Mobile memory, steady state with 60k transactions | <= 250 MB |
| Bundles | mobile JS (Hermes bytecode) <= 8.30 MB ceiling (M1 companion budget, see note); desktop renderer initial chunk <= 1.5 MB minified, routes lazy |
| Render regressions on key screens (Reassure) | <= 10% more renders or render time than the baseline |

Mobile bundle note (lead, 2026-11-01, from S41b measurements): the first 4 MB budget was a guess. React Native +
expo-router + Reanimated alone are about 4.4 MB of Hermes bytecode, so the target is 6.0 MB = framework baseline plus
at most 1.6 MB of our own code and libraries. The ceiling is a RATCHET: it starts at the measured 6.9 MB and may only be
lowered (each reduction lowers it in the same commit); raising it needs the lead. The user-facing gate stays cold start
(p50 <= 1.5 s), which the app already meets on the iOS simulator (about 1.17 s).

S41d ratchet (2026-11-01): retaining only Zod's original English locale in the mobile Metro graph,
with the S41c diagnostics fixes, measures 6,722,209 B on iOS and 6,706,184 B on Android. The ceiling
is lowered to 6.73 MB (the larger measurement rounded up to 0.01 MB); the 6.0 MB target stays.

Ratchet (2026-11-08): the phone had grown past the ceiling (6,854,983 B iOS) through three imports
Metro cannot tree-shake: native.css scanned whole packages/ui folders, so Uniwind compiled the desktop
chart renderer's and desktop-only components' classes (114 KB of JS, now 31 KB); the investments index
carried the research layer as a value namespace (now `@cashu/domain/investments/research`, the store's
fold reads only `.../research/contract`); the core index carried the agent workspace templates (now
`@cashu/domain/core/workspace`). Measured 6,590,065 B on iOS and 6,566,198 B on Android; the ceiling
is lowered to 6.60 MB. The tools/arch guard nativeStyles.test.ts keeps native.css to the phone's files.

Companion budget (owner, 2026-11-12): the 6.0 MB target and the 6.60 MB ratchet could not hold the mobile
companion (four tabs, sheets, the display layer, the store's companion queries, later the investments
domain). The owner decided that bundle size is not a product concern ("you can raise it even more; Flutter
apps weigh ~50 MB and that is fine"); the user-facing gates stay cold start p50 <= 1.5 s / p95 <= 2.5 s on
the reference device, memory and list performance. The ceiling is therefore set per milestone from a
measurement plus real headroom: M1 8.30 MB, M2 9.30 MB, M3 9.60 MB. Within a milestone it stays a ratchet
(a regression guard: it may only be lowered); each milestone commit lists the top bundle owners from
`bundle-size.mjs --report` and its cold-start measurement.

## Rules that keep the budgets

- **React Compiler** everywhere (Expo default; Babel plugin in the Electron Vite build); no manual
  memo. Re-render problems are fixed by data shape (structural sharing, narrower queries, Zustand
  selectors), not by `memo`.
- **Virtualize every list that can exceed ~50 rows**: FlashList v2 on mobile, TanStack Virtual on the
  desktop. Share the row's data shape, not the list component. Queries page with SQL keyset pagination
  or windows, so JS never holds all 60k rows.
- **Hoist `Intl` formatters** (`NumberFormat`, `DateTimeFormat`, `PluralRules`) per locale in the i18n
  layer; never construct them in render.
- Heavy work belongs in the store (derived tables, indexed queries) or the local host, never in
  render or on the Electron main process.
- Mobile animation: Reanimated, transform and opacity only.

## Measuring

Mobile: Flashlight / the Perf Monitor for FPS, `expo-dev-client` release builds for startup, Reassure
for render counts. Desktop: Chrome DevTools performance panel on the renderer, `performance.mark` around
query runs (the store logs runs over budget in development).

## Store apply and rebuild against the spike (S23b)

The first gate, "bulk apply and full rebuild within 2x of the own-log spike", is RETIRED (lead,
2026-10-31): the store does more work per event than the spike (gid index, view ids, natural keys,
zod validation, keyed HMAC), so the gate is the user-facing store budgets in the table above, measured
on an idle machine. The spike numbers below stay as a reference. Workload: `packages/store/src/perf.test.ts` (64,203 events: 60k imports, 2k re-imports, 1,900
rule edits, 300 decisions, 1,000-event apply batches, one transaction each) vs
`spike/own-log/bench.mjs`; harness `~/cashu-lab/bench/s23b-same-run.sh` (interleaved rounds, medians,
wall ms; file mode with WAL + synchronous NORMAL, the store's own pragmas and the spike's, is the
gate). M-series Mac; the load average is given per step because other sessions shared the machine.

| Step | Load avg | Spike bulk / rebuild | Store file bulk / rebuild | Store memory bulk / rebuild | Ratio file bulk / rebuild |
|---|---|---|---|---|---|
| Before (8cb17e5) | 3-8 | 476 / 414 | 6,680 / 1,242 | 3,709 / 984 | 14.0 / 3.00 |
| Keyed HMAC per vault, no transaction partition index | 4-5 | 474 / 342 | 4,242 / 804 | 2,596 / 732 | 9.0 / 2.35 |
| Bulk index build on full re-folds | 6-10 | 452 / 336 | 4,225 / 753 | 2,505 / 630 | 9.4 / 2.24 |
| Batched log writes, one envelope copy | 5-6 | 481 / 325 | 4,471 / 740 | 2,305 / 651 | 9.3 / 2.28 |
| Cash-leg refs on demand | 166-174 | 667 / 438 | 4,832 / 977 | 2,819 / 858 | 7.3 / 2.23 |
| Queued multi-row materializer inserts and view ids | 73-77 | 713 / 503 | 5,253 / 973 | 2,182 / 711 | 7.4 / 1.93 |
| Compact log copy (DB 80.5 -> 62.4 MB) | 93-115 | 759 / 475 | 4,850 / 1,115 | 3,299 / 1,017 | 6.4 / 2.35 |
| After (WAL pragmas in the store, 5 rounds) | 119-147 | 751 / 458 | 5,319 / 1,212 | 3,229 / 1,050 | 7.1 / 2.65 |

Against the retired 2x gate this was not met; against the user budgets it is (see S24a below:
bulk 5.4-7.2 s <= 10 s, rebuild ~1.2 s <= 3 s, a day 48-51 ms <= 100 ms). From the cash-leg step on
the machine was shared (load average 70-150), which slows the store's longer runs more than the
spike's short ones: single rounds of one step spread by 30-40%, so
read the late rows as ranges; the idle-machine re-measure (one transaction per sync pull, S29c-B3) is
pending, see "Signed heads and the batch API" below. Where the bulk time goes (CPU profile): SQLite B-tree work of the inserts dominates; a
transaction import still inserts into five random-key B-trees (the log's gid index, `view_ids`, the
transaction's gid, its (account, hash, occurrence) key, its booking date) where the spike inserts into
two, plus zod validation and the gid check (one HMAC). File mode adds the WAL page writes of those
trees on every 1,000-event commit (applying the whole bulk in one transaction, as the spike's sync
does, measured ~15-25% faster).

Field table for the log copy (S23c, `engine/field-table.ts`, events.md 4.5): positions come from the
append-only table instead of the live schema order; same bytes on disk. Interleaved before / after in
one run, 3 rounds each, CPU ms medians, memory mode, load average 128-210: S24a workload bulk 3,300 ->
3,174, rebuild 1,145 -> 1,112; S25 workload bulk 868 -> 818, rebuild 328 -> 336, owner merge 283 ->
287 (all within noise).

## Signed heads and the batch API (S29c-B3)

Every frame carries its writer's Ed25519 head signature (S29c-B2): a write signs one head per frame,
and a reader checks each foreign frame's head once (the gate memoizes; the engine asks on pull and on
apply). Both run on @noble/curves, the same code as on the phone (Hermes is slower by a factor that
S41g measures on a device). The carrier harness `packages/sync/src/carriers/folder.perf.test.ts`
counts every head signature made and checked with its CPU time and prints `headSigns`,
`headSign_cpu_ms`, `headSign_us_per_frame`, `headVerifies`, `headVerify_cpu_ms` and
`headVerify_us_per_frame` next to the S28b numbers (ceilings 5 ms per sign and 10 ms per check, CI
headroom). Per 64k-event first sync at 1,000 events per frame that is ~65 checks, so the cost per pull
is small; many tiny frames (one per command) are where it adds up.

Since S29c-B3 a sync pass reaches the store in one transaction (`EventSink.applyBatches`, chunked at
25,000 events or 32 MiB of plaintext), and a write appends all its frames in one atomic append.

| Measurement | Status |
|---|---|
| Head sign / verify per frame (counts, CPU ms) | pending: the machine was shared (load average 35-60) during S29c-B3; run on an idle machine (load average below 20, announced first) |
| Store bulk apply, one transaction per pull vs one per batch; noble vs node HMAC | pending, same reason |

## Core and budget vault (S24a)

Workload: `packages/store/src/perf.test.ts` (66,534 events: the S23b workload plus the cash pool, 2,000
category claims of which 133 make cash legs, 300 cash expenses, 30 loan events; 1,000-event batches),
with the budget derivers (cash legs, claim categories) and `fold_txn_keys` (anchor order, amount and
merchant keys) on. One run each, wall (CPU) ms, load average 6-7, same machine.

| Phase | Memory | File (WAL, synchronous NORMAL) | Budget |
|---|---|---|---|
| bulk apply (genesis-size) | 2,644 (3,034) | 5,441-7,241 (5,054-5,754) | first sync desktop <= 10 s |
| full rebuild | 952-979 (1,066-1,103) | 1,235-1,257 (1,351-1,381) | desktop <= 3 s |
| a day's events (200 imports, 5 cash withdrawal claims) | 11 (16) | 48-51 (37-39) | <= 100 ms |
| late claim re-fold / identity re-fold of 60k rows | 12 / 876-883 | 18 / 1,125-1,418 | (none) |

Two plans found by profiling this workload, both fixed: `EventLog.keyedEvent` (gid + type) let SQLite
walk the `(type, hlc, eid)` index for the ORDER BY instead of the gid index (7 ms per claim at 60k
imports; now `+type`), and rows addressed by `dedup_hash` alone scan `transactions` (cash expenses are
addressed by gid). The derived oracle (`Store.rederive`, every deriver's deriveAll) costs ~1 s at this
size: tests only.

With the effective categories (S24c, `budget/derive/categories.ts`: the S09 engine, recurring groups
kept per (payee, currency, amount)), same workload, one run each, wall (CPU) ms, load average 8-20;
the "stub" column is the same tree with the categories deriver switched off:

| Phase | Memory | File | File, stub | Budget |
|---|---|---|---|---|
| bulk apply, 1,000-event batches | 5,374 (6,301) | 10,358-10,751 (10,180-10,248) | 5,308 (4,760) | first sync desktop <= 10 s |
| bulk apply, one apply (a sync pull: one transaction, 25k-event chunks) | - | 3,639 (4,004) | - | first sync desktop <= 10 s |
| full rebuild | 1,383-1,402 | 1,648-1,668 | 1,156 | desktop <= 3 s |
| a day's events | 15-17 | 64-67 | 51 | <= 100 ms |

A full pass costs ~8 us per row (it writes only what changed); the incremental path ~70 us per dirty
row (SQLite: one membership row per outflow, two B-trees, plus the category update), so a batch
dirtying more than an eighth of the rows takes the full pass. The 1,000-event bulk is over the line
on a loaded machine; a first sync goes through the sink's pull transaction (chunks of 25k events, each
dirtying more than an eighth of the rows, so each takes the full pass), well inside it.

## Rebuild after an app update (S23d)

`Store.open` compares each view component's recorded version and DDL fingerprint (`view_defs`) and
rebuilds only what the upgrade rule in `packages/store/src/rebuild.ts` selects; before S23d every
definitions change rebuilt the whole view with the refs re-indexed. Same workload and run as S24a
(`perf.test.ts`, 66,534 events), CPU ms, 2 memory runs and 1 file run, load average 50-100 (shared
machine):

| Open | Memory | File (WAL) | Budget |
|---|---|---|---|
| unchanged definitions (median of 5 reopens) | 1-2 | 2 | (none: one extra `store_meta` read vs before) |
| before: any definitions change (whole view + refs) | 1,244-1,634 | 2,085 | desktop <= 3 s |
| after: `budget.category_rules` bumped (partial) | 13-25 | 14 | |
| after: `budget.transactions` bumped (whole view: it indexes refs) | 1,354-1,615 | 1,743 | desktop <= 3 s |

The upgrade (DDL, rebuild, new record) is one transaction, so its cost is all inside the open; the
UI gets `StoreOptions.onRebuild` progress (`start`, `step`, `fold` every 4,096 events, `done`).

## Investments vault (S25)

Workload: `packages/store/src/investments/perf.test.ts` with `CASHU_PERF=1` (30,133 events: 5k inv
transactions over 300 instruments with 2 aliases each, 2k signals with refresh churn, 500 notes, 50
alerts evaluated daily for a year, 200 thesis updates; in memory, 1,000-event batches). CPU ms of the
test worker, 3 runs, load average 92-112 (shared machine: CPU time only; re-measure idle).

| Phase | CPU ms | Budget |
|---|---|---|
| bulk apply (genesis-size) | 817-877 | first sync desktop <= 10 s |
| full rebuild | 321-346 | desktop <= 3 s |
| a day's events (1 rule run, 40 signal refreshes, 50 evaluations) | 2 | <= 100 ms |
| one owner instrument merge (full re-fold of every instrument-keyed table) | 277-287 | (none) |
