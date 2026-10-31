// Acceptance (fast tier): on every shared scenario (`reference/testing/scenarios.ts`) the production
// store equals the executable reference fold (`events/v1/reference/fold.ts`) and converges on a few
// delivery orders (single events and random batches, re-delivered duplicates), with the derived
// oracle after every batch and rebuild == incremental. Every one of the ORDERS deliveries runs in
// convergence.exhaustive.test.ts.
import { describe, it } from "vitest";
import { SCENARIOS, syntheticDet } from "./events/v1/reference/testing/scenarios.js";
import { converge } from "./testing/convergence.js";

/** Two single-event and two batched deliveries. */
const FAST_ORDERS = [0, 1, 2, 3];

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it(`production fold = reference fold: ${s.name}`, () =>
      s.check(converge(s.events, syntheticDet(s.events), FAST_ORDERS)));
  });
}
