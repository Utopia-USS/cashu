// Exhaustive tier: the rule-6 property over many seeded schedules (one test per schedule; the
// default tier runs one schedule of each kind in lease.test.ts and lease.pinned.test.ts). Never two
// fetch leaders at once on either backend kind (S29c R4):
// - mode auto over a linearizable remote and over a relay keeping a 2-minute bound, even with a
//   device whose clock runs 2 days ahead; all devices agree after convergence; the fold is a
//   function of the event set;
// - mode auto over a synced folder (eventual): nobody ever holds; the control (devices believing
//   their folder is bounded) DOES break the property, so the check has teeth.
// Mode pinned: lease.pinned.rule6.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { rule6Run } from "../testing/devices/leaseSim.js";

const seeds = (n: number) => Array.from({ length: n }, (_, run) => run);

describe("fetch lease property (rule 6), every schedule", () => {
  let held = 0;

  it.each(seeds(60))("auto, linearizable remote, schedule %i", async (run) => {
    const result = await rule6Run(run);
    if (result.fullVisibility && result.held) held += 1;
  });

  // Runs after the schedules (tests of a file run in order): they really exercise the lease.
  it("most full-visibility schedules hand the lease to someone", () => {
    expect(held).toBeGreaterThanOrEqual(35);
  });

  let boundedHeld = 0;
  it.each(seeds(24))("auto, bounded relay, schedule %i", async (run) => {
    const result = await rule6Run(run, "bounded");
    if (result.fullVisibility && result.held) boundedHeld += 1;
  });

  it("over the bounded relay the lease is handed to someone in most schedules", () => {
    expect(boundedHeld).toBeGreaterThanOrEqual(12);
  });

  it.each(seeds(20))("auto, synced folder: nobody holds, schedule %i", async (run) => {
    expect((await rule6Run(run, "eventual")).held).toBe(false);
  });

  let controlOverlaps = 0;
  it.each(seeds(6))("control: a folder believed bounded, schedule %i", async (run) => {
    if ((await rule6Run(run, "eventual", true)).overlap) controlOverlaps += 1;
  });

  it("the control breaks rule 6 in some schedule (the property can fail)", () => {
    expect(controlOverlaps).toBeGreaterThan(0);
  });
});
