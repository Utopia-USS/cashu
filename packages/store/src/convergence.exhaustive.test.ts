// The conflict rules of events.md (exhaustive tier): every shared scenario in all ORDERS deliveries
// (events.md 6.7), one small test per scenario and slice of orders.
import { describe, it } from "vitest";
import { converge } from "./testing/convergence.js";
import { ORDERS, SCENARIOS, syntheticDet } from "./testing/scenarios.js";

const SLICE = 6;
const SLICES = Array.from({ length: Math.ceil(ORDERS / SLICE) }, (_, i) =>
  Array.from({ length: SLICE }, (_, j) => i * SLICE + j).filter((k) => k < ORDERS),
);

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it.each(SLICES.map((orders, i) => [i, orders] as const))(
      `${s.name} (orders slice %i)`,
      (_, orders) => s.check(converge(s.events, syntheticDet(s.events), orders)),
    );
  });
}
