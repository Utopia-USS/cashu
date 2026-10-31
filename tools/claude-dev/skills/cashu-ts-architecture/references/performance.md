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
