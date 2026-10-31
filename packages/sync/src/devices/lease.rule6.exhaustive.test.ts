// Exhaustive tier: the rule-6 property over 60 seeded schedules (one test per schedule; the default
// tier runs one schedule of each kind in lease.test.ts). Never two fetch leaders at once, even with a
// device whose clock runs 2 days ahead; all devices agree after convergence; the fold is a function
// of the event set.

import { describe, expect, it } from "vitest";
import { rule6Run } from "./leaseSim.js";

const RUNS = Array.from({ length: 60 }, (_, run) => run);

describe("fetch lease property (rule 6), every schedule", () => {
  let held = 0;

  it.each(RUNS)("schedule %i", async (run) => {
    const result = await rule6Run(run);
    if (result.fullVisibility && result.held) held += 1;
  });

  // Runs after the schedules (tests of a file run in order): they really exercise the lease.
  it("most full-visibility schedules hand the lease to someone", () => {
    expect(held).toBeGreaterThanOrEqual(35);
  });
});
