// Exhaustive tier: the decision-key property (decisionKeysProperty.ts) over 60 seeded random
// certification graphs with random revocations, one test per seed; decisionKeys.test.ts runs a few.

import { describe, expect, it } from "vitest";
import { decisionKeysRun } from "../testing/devices/decisionKeysProperty.js";

describe("decision keys property, every seed", () => {
  let minters = 0;

  it.each(Array.from({ length: 60 }, (_, i) => i + 1))("seed %i", async (seed) => {
    minters += (await decisionKeysRun(seed)).minters;
  });

  // Runs after the seeds (tests of a file run in order): the graphs really revoke and mint.
  it("most seeds revoke someone who then mints", () => {
    expect(minters).toBeGreaterThanOrEqual(40);
  });
});
