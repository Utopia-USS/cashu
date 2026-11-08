// The strategy loader against Python on the seeded mutations of the oracle inputs (vectors from
// the retired Python vectors_inv_strategy.py, inv-strategy-random). Rows where Python raises outside the
// loader's contract (an empty `!!float` / `!!int` scalar: IndexError in PyYAML's constructor) must
// load in TS, where the scalar stays text.

import { describe, it } from "vitest";
import { expectAll, loadVectors } from "../../testing/vectors.js";
import { replay } from "./testing/vectorRows.js";

const rows = loadVectors("inv-strategy-random").rows;
const SLICE = 100;
const starts = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);

describe("inv-strategy-random vectors", () => {
  it.each(starts)("rows %i.. : load results equal Python", (start) => {
    expectAll(replay(rows.slice(start, start + SLICE), start));
  });
});
