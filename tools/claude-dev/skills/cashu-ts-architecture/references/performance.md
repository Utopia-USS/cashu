---
title: Performance budgets
impact: HIGH
tags: performance, budgets, virtualization, react-compiler, startup
---

# Performance budgets

Proposed numbers (S51, to be confirmed by the first measurements on real hardware). Reference
devices: iPhone 13 class for mobile, an M1 MacBook Air for desktop. Data: the 60k-transaction synthetic
profile. A change that breaks a budget needs a measurement and the lead's OK, not a new number.

| Budget | Target |
|---|---|
| Mobile cold start to first data on screen (snapshot present) | p50 <= 1.5 s, p95 <= 2.5 s |
| Desktop window shown to first data | <= 1.0 s after the utility process is ready |
| Snapshot load (mobile) / full rebuild from the log | <= 0.5 s / <= 10 s desktop, <= 30 s mobile in the background |
| One live query on a UI-facing thread | <= 8 ms per run (half a 60 Hz frame); slower moves to a derived table or off-thread |
| Local command to updated UI | p95 <= 50 ms (no perceptible lag below 100 ms) |
| Tap / click to visual response | <= 100 ms |
| Scrolling the 60k list | no dropped frames > 1% in a 10 s fling at 60 Hz (120 Hz on ProMotion) |
| Mobile memory, steady state with 60k transactions | <= 250 MB |
| Bundles | mobile JS (Hermes bytecode) <= 4 MB; desktop renderer initial chunk <= 1.5 MB minified, routes lazy |
| Render regressions on key screens (Reassure) | <= 10% more renders or render time than the baseline |

## Rules that keep the budgets

- **React Compiler** everywhere (Expo default; Babel plugin in the Electron Vite build); no manual
  memo. Re-render problems are fixed by data shape (structural sharing, narrower queries, Zustand
  selectors), not by `memo`.
- **Virtualize every list that can exceed ~50 rows**: FlashList v2 on mobile, TanStack Virtual on the
  desktop. Share the row's data shape, not the list component. Queries page with SQL keyset pagination
  or windows, so JS never holds all 60k rows.
- **Hoist `Intl` formatters** (`NumberFormat`, `DateTimeFormat`, `PluralRules`) per locale in the i18n
  layer; never construct them in render.
- Heavy work belongs in the store (derived tables, indexed queries) or the utility process, never in
  render or on the Electron main process.
- Mobile animation: Reanimated, transform and opacity only.

## Measuring

Mobile: Flashlight / the Perf Monitor for FPS, `expo-dev-client` release builds for startup, Reassure
for render counts. Desktop: Chrome DevTools performance panel on the renderer, `performance.mark` around
query runs (the store logs runs over budget in development).

## Store apply and rebuild against the spike (S23b)

Gate (lead decision): bulk apply and full rebuild within 2x of the own-log spike, measured in the same
run. Workload: `packages/store/src/perf.test.ts` (64,203 events: 60k imports, 2k re-imports, 1,900
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

Not met. From the cash-leg step on the machine was shared (load average 70-150), which slows the
store's longer runs more than the spike's short ones: single rounds of one step spread by 30-40%, so
read the late rows as ranges and re-measure on an idle machine before a decision. Where the bulk time goes (CPU profile): SQLite B-tree work of the inserts dominates; a
transaction import still inserts into five random-key B-trees (the log's gid index, `view_ids`, the
transaction's gid, its (account, hash, occurrence) key, its booking date) where the spike inserts into
two, plus zod validation and the gid check (one HMAC). File mode adds the WAL page writes of those
trees on every 1,000-event commit (applying the whole bulk in one transaction, as the spike's sync
does, measured ~15-25% faster).

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
