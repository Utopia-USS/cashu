// Exhaustive tier: the mode-pinned rule-6 property (S29c R4) over many seeded schedules (one test
// per schedule; lease.pinned.test.ts runs one of each kind). Three devices on a synced folder
// (eventual: delays up to 30 minutes, some batches held back) or a bounded relay; the owner re-pins
// the fetch leader at random, typed on a random device or with the recovery words. Without force:
// never two holders, and a leader whose hand-over is done holds at its next pull. With force (D4):
// overlaps happen, and each one is a holder that has not seen a forced pin the other has.

import { describe, expect, it } from "vitest";
import { pinnedRun } from "./leaseSim.js";

const seeds = (n: number) => Array.from({ length: n }, (_, run) => run);

describe("pinned fetch leader property (rule 6), every schedule", () => {
  it.each(seeds(24))("pinned, synced folder, re-pins without force, schedule %i", async (run) => {
    expect((await pinnedRun(run, "eventual", false)).overlaps).toBe(0);
  });

  it.each(seeds(16))("pinned, bounded relay, re-pins without force, schedule %i", async (run) => {
    expect((await pinnedRun(run, "bounded", false)).overlaps).toBe(0);
  });

  let forcedOverlaps = 0;
  it.each(seeds(16))("pinned, synced folder, forced re-pins, schedule %i", async (run) => {
    forcedOverlaps += (await pinnedRun(run, "eventual", true)).overlaps;
  });

  it("a forced re-pin is the only way to two leaders, and it does happen", () => {
    expect(forcedOverlaps).toBeGreaterThan(0);
  });
});
