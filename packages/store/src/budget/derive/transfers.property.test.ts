// Property search over random budget scripts for internal transfers (fast tier, S24b): delivery
// orders and duplicates give one view hash, the derived oracle holds after every batch, the transfer
// columns and categories equal the domain recompute (D-24.1), rebuild == incremental. The long search
// over many seeds is transfers.property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { transfersProperty } from "../../testing/transfer-script.js";

describe("property: internal transfers on random synthetic budget scripts", () => {
  it.each([0, 1, 2])("orders, derived oracle, recompute, rebuild: seed slice %i", (i) => {
    fc.assert(transfersProperty, { numRuns: 6, seed: 80_000 + i });
  });
});
