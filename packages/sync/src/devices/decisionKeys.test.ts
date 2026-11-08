// The decision-key property (decisionKeysProperty.ts) on a few seeds; the sweep is
// decisionKeys.property.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { decisionKeysRun } from "../testing/devices/decisionKeysProperty.js";

describe("decision keys property", () => {
  it.each([1, 2])(
    "seed %i: keys minted through revoked devices never change a decision in their favour",
    async (seed) => {
      await decisionKeysRun(seed);
    },
  );

  it("the seeds exercise minting (some device is revoked)", async () => {
    expect((await decisionKeysRun(3)).minters + (await decisionKeysRun(4)).minters).toBeGreaterThan(
      0,
    );
  });
});
