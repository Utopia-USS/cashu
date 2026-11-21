// The conflict rules of events.md (fast tier): every shared scenario (testing/scenarios.ts) folds
// to one view on a single-event and a batched delivery (both shuffled, with re-delivered
// duplicates), keeps the derived oracle after every batch and rebuild == incremental, and the view
// passes the scenario's checks. Every one of the ORDERS deliveries runs in
// convergence.exhaustive.test.ts.
import { describe, it } from "vitest";
import { converge } from "./testing/convergence.js";
import { SCENARIOS, syntheticDet } from "./testing/scenarios.js";

/** One single-event and one batched delivery. */
const FAST_ORDERS = [0, 1];

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it(s.name, () => s.check(converge(s.events, syntheticDet(s.events), FAST_ORDERS)));
  });
}
