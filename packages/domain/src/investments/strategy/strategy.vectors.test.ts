// The strategy loader against Python `load_strategy` (vectors from
// parity/python/vectors_inv_strategy.py, inv-strategy-cases: the shipped templates and every input
// the oracle test files hand to the loader, with the whole load result: config, partial config,
// inactive rules and every issue with its code, params, path, line and column). The mutated corpus
// replays in strategy.vectors.exhaustive.test.ts.

import { describe, it } from "vitest";
import { expectAll, loadVectors } from "../../testing/vectors.js";
import { replay } from "./testing/vectorRows.js";

const rows = loadVectors("inv-strategy-cases").rows;
const SLICE = 25;
const starts = Array.from({ length: Math.ceil(rows.length / SLICE) }, (_, i) => i * SLICE);

describe("inv-strategy-cases vectors", () => {
  it.each(starts)("rows %i.. : load results equal Python", (start) => {
    expectAll(replay(rows.slice(start, start + SLICE), start));
  });
});
