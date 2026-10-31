---
title: Testing per layer
impact: HIGH
tags: testing, vitest, parity, convergence, renderHook, storybook, e2e
---

# Testing per layer

| Layer | What | How |
|---|---|---|
| domain | behaviour of the ported Python | vitest; translate the oracle pytest file test-for-test (name the Python test in a comment); vectors for primitives; parity checks on `demo` and `lab` |
| store | events, gids, materializers, queries, commands, invalidation | schema tests (valid / invalid), gid vectors, convergence (same event set in N shuffled orders and with duplicates gives identical view hashes), command tests on the in-memory store, a test that each command's touched tables re-run the queries that read them |
| sync | crypto, log, transports | vectors, tamper tests, multi-device simulations, a contract suite every carrier passes |
| ui-logic + screen hooks | feature and screen hooks | `renderHook` inside the real in-memory store provider (never a mocked store); drive commands, assert the returned state |
| ui + Views | components and Views | Storybook stories (every variant and phase) run as tests by the Vitest addon, with the a11y addon; React Native Testing Library for native-only behaviour; Playwright screenshots of stories for visual regression (see `cashu-ui`) |
| apps | screens end to end | desktop: Playwright on the Electron window with demo data; mobile: Maestro flows in CI, agent-device for agent runs; never real data |

Rules:

- Synthetic data only in tests, fixtures and stories. Real data is touched only by parity runs on a
  copy, which report counts, hashes and pass / fail.
- A bug fix starts with a failing test at the lowest layer that can show it.
- Time comes from an injected `Clock`; tests never depend on today's date.
- No snapshot tests of whole screens; assert on meaning (labels, state kinds, events appended).
  Visual regression is screenshots of stories, reviewed as images.
- Performance-sensitive screens get a Reassure render test (see [performance.md](performance.md)).
