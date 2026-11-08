---
title: Testing per layer
impact: HIGH
tags: testing, vitest, vectors, convergence, renderHook, storybook, e2e
---

# Testing per layer

| Layer | What | How |
|---|---|---|
| domain | behaviour of the rules | vitest; behaviour tests per rule; small curated vector files (`test/vectors`) for primitives, whose expected values are the spec |
| store | events, gids, materializers, queries, commands, invalidation | schema tests (valid / invalid), gid vectors, convergence (same event set in N shuffled orders and with duplicates gives identical view hashes), command tests on the in-memory store, a test that each command's touched tables re-run the queries that read them |
| sync | crypto, log, transports | vectors, tamper tests, multi-device simulations, a contract suite every carrier passes |
| ui-logic + screen hooks | feature and screen hooks | `renderHook` inside the real in-memory store provider (never a mocked store); drive commands, assert the returned state |
| ui + Views | components and Views | Storybook stories (every variant and phase) run as tests by the Vitest addon, with the a11y addon; React Native Testing Library for native-only behaviour; Playwright screenshots of stories for visual regression (see `cashu-ui`) |
| apps | screens end to end | desktop: Playwright on the Electron window with demo data; mobile: Maestro flows in CI, agent-device for agent runs; never real data |

Rules:

- Synthetic data only in tests, fixtures and stories.
- Vector files stay small: each row is there because it covers a branch, a boundary, an error path or
  a category the others do not. Add a row for a new case; never bulk-generate thousands of rows.
- A bug fix starts with a failing test at the lowest layer that can show it.
- Time comes from an injected `Clock`; tests never depend on today's date.
- No snapshot tests of whole screens; assert on meaning (labels, state kinds, events appended).
  Visual regression is screenshots of stories, reviewed as images.
- Performance-sensitive screens get a Reassure render test (see [performance.md](performance.md)).

## Test tiers

Two tiers, one per-test timeout: vitest's default 5 s in both. A test that needs more time is split,
never given a longer budget.

| Tier | Files | Command | Runs |
|---|---|---|---|
| default (fast) | every `*.test.ts(x)` except the exhaustive ones | `pnpm turbo run test` (or `vitest run` in a package) | on every change, before a commit, in CI |
| exhaustive | `*.exhaustive.test.ts(x)` | `pnpm test:exhaustive` (turbo task `test:exhaustive`, `--concurrency=1`) | in CI (`.github/workflows/ts.yml`) and in the pre-handoff gate `pnpm check:handoff` |

`pnpm test:exhaustive` runs one package at a time (`--concurrency=1`): each suite is seconds of CPU and
vitest already spreads its files over every core, so running packages side by side only oversubscribes
the machine and makes timings depend on what else is running. One package in a run:
`CASHU_TEST_TIER=exhaustive pnpm --filter @cashu/domain exec vitest run`.

A test file belongs in the exhaustive tier when it covers an input space instead of a behaviour, and
all of its tests together cost more than about 300 ms CPU even after the code under test is fast:

- vector sweeps over every code point, every generated text or every generated case;
- property searches over many seeds or iterations;
- multi-device simulations (many replicas, permutations, paging) in `sync` and `store`.

It does not belong there when it checks one behaviour, replays a few hundred rows in well under
300 ms, or is the only test that guards a rule (those stay in the default tier, however slow the
author thinks they are: speed the code up first).

Rules for an exhaustive file:

- Name it `<subject>.<what>.exhaustive.test.ts` next to the code (`text.codepoints.exhaustive.test.ts`).
  Split a mixed file: the small checks stay in the default file, the sweeps move out.
- Split the sweep into small tests so none is above about 100 ms CPU: one per Unicode plane, per slice
  of vectors, per seed (`it.each`). Keep every assertion; the slices together cover the same inputs.
- It must not depend on wall-clock budgets: no assertion on elapsed time, no `Date.now()` / `performance.now()`
  deadline, no timeout raised for the file. Budget CPU work by counting operations or by size, and
  fix a slow path in production code (hoist, memoize, one pass) before touching the test.
- Hash or compare in bulk (one digest per block of inputs, one deep equality per slice), not per item.
- Fast and exhaustive tiers use the same helpers (`vectors.ts`: `blockHash`, `PLANES`, `expectAll`).

Wiring: every package's `vitest.config.ts` is `export default tiered()` from the root `vitest.tiers.ts`
(it excludes the exhaustive files, or with `CASHU_TEST_TIER=exhaustive` includes only them) and its
`package.json` has the `test:exhaustive` script. A guard in `tools/arch` (`packages.test.ts`) fails
`pnpm arch:check` for a package without both, so a `*.exhaustive.test.ts` file can never run in the
fast tier by accident.
