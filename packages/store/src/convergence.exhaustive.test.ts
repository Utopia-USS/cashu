// Acceptance (exhaustive tier): every shared scenario in all ORDERS deliveries (events.md 6.7), one
// small test per scenario and slice of orders.
import { describe, it } from "vitest";
import { ORDERS, SCENARIOS, syntheticDet } from "./events/v1/reference/testing/scenarios.js";
import { converge } from "./testing/convergence.js";

const SLICE = 6;
const SLICES = Array.from({ length: Math.ceil(ORDERS / SLICE) }, (_, i) =>
  Array.from({ length: SLICE }, (_, j) => i * SLICE + j).filter((k) => k < ORDERS),
);

for (const s of SCENARIOS) {
  describe(s.group, () => {
    it.each(SLICES.map((orders, i) => [i, orders] as const))(
      `production fold = reference fold: ${s.name} (orders slice %i)`,
      (_, orders) => s.check(converge(s.events, syntheticDet(s.events), orders)),
    );
  });
}
