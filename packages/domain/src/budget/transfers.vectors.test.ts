// The Python differential vectors of the transfer port (`parity/python/vectors_budget_transfers.py`):
// every amount key and every matching scenario. The whole replay costs well under 300 ms, so it stays in
// the default tier (testing.md "Test tiers"), in slices of 100 scenarios.

import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { expectAll, loadVectors, Mismatches } from "../testing/vectors.js";
import { PYTHON_PLAN, replayScenarios, TRANSFER_SCENARIOS } from "./testing/transferVectors.js";
import { transferAmountKey } from "./transfers.js";

const SLICE = 100;
const slices = Array.from(
  { length: Math.ceil(TRANSFER_SCENARIOS.length / SLICE) },
  (_, i) => i * SLICE,
);

describe("transfer vectors", () => {
  it("cover the generated set", () => {
    expect(TRANSFER_SCENARIOS.length).toBe(1500);
    expect(TRANSFER_SCENARIOS.reduce((n, s) => n + s.pairs.length, 0)).toBeGreaterThan(1000);
    expect(TRANSFER_SCENARIOS.filter((s) => s.staleReset).length).toBeGreaterThan(50);
  });

  it("PARITY(Q2): Python reads the ungrouped rows through the transfer-group index, in rowid order", () => {
    expect(
      PYTHON_PLAN.startsWith("SEARCH transactions USING INDEX ix_transactions_transfer_group_id"),
    ).toBe(true);
  });

  it('transferAmountKey equals Python\'s f"{x:.2f}" / f"{-x:.2f}" on 3000 adversarial decimals', () => {
    const m = new Mismatches();
    for (const [, text, key] of loadVectors("budget-transfer-keys").rows as [
      string,
      string,
      string | null,
    ][]) {
      m.check(text, transferAmountKey(D(text)), key);
    }
    expectAll(m);
  });

  it.each(slices)("scenarios %i.. equal Python's pairs", (start) => {
    expectAll(replayScenarios(TRANSFER_SCENARIOS.slice(start, start + SLICE)));
  });
});
