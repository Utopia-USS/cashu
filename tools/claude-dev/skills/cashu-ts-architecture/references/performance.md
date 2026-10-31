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
rule edits, 300 decisions) vs `spike/own-log/bench.mjs`; harness `~/cashu-lab/bench/s23b-same-run.sh`
(3 interleaved rounds, medians, wall ms; file mode = WAL + synchronous NORMAL, the spike's pragmas, is
the gate). M-series Mac, load average 3-10.

| Step | Spike bulk / rebuild | Store file bulk / rebuild | Store memory bulk / rebuild | Ratio file bulk / rebuild |
|---|---|---|---|---|
| Before (8cb17e5) | 476 / 414 | 6,680 / 1,242 | 3,709 / 984 | 14.0 / 3.00 |
| Keyed HMAC per vault, no transaction partition index | 474 / 342 | 4,242 / 804 | 2,596 / 732 | 9.0 / 2.35 |
| Bulk index build on full re-folds | 452 / 336 | 4,225 / 753 | 2,505 / 630 | 9.4 / 2.24 |
| Batched log writes, one envelope copy (after) | 481 / 325 | 4,471 / 740 | 2,305 / 651 | 9.3 / 2.28 |

Not met (bulk 9.3x, rebuild 2.3x in file mode; memory 4.8x / 2.0x). Where the bulk time goes (CPU
profile, file mode): the commit's WAL writes about 30% (the store database is 80 MB after the bulk vs
the spike's 29 MB of log + view: the log copy is 577 bytes per event and each import inserts into six
random-key B-trees: the log's gid index, the cash-leg ref, `view_ids`, the transaction's gid, its
(account, hash, occurrence) key and its booking date), the transaction row insert about 12%, zod and
the HMACs together under 10%. Options left are design changes for the lead (S23b checkpoint): cash-leg refs
on demand, a more compact log copy, batched materializer inserts.
