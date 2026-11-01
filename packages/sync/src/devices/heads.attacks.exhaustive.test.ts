// Exhaustive tier: the signed-heads attack sweeps (seeds 2-9; seed 1 runs in heads.attacks.test.ts).

import { describe, it } from "vitest";
import { forgeryRun, rewriteRun } from "./headsSim.js";

const SEEDS = Array.from({ length: 8 }, (_, i) => i + 2);

describe("signed heads: sweeps", () => {
  it.each(SEEDS)("A1b rewrite, seed %i", async (seed) => {
    await rewriteRun(seed);
  });
  it.each(SEEDS)("m6 forgery, seed %i", async (seed) => {
    await forgeryRun(seed);
  });
});
