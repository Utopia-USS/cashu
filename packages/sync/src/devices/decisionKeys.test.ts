// The decision-key property (decisionKeysProperty.ts) on two seeds that revoke and mint; the sweep is
// decisionKeys.property.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { decisionKeysRun } from "../testing/devices/decisionKeysProperty.js";

describe("decision keys property", () => {
  it.each([2, 3])(
    "seed %i: keys minted through revoked devices never change a decision in their favour",
    async (seed) => {
      // The seed really mints (a run without a revoked device would prove nothing).
      expect((await decisionKeysRun(seed)).minters).toBeGreaterThan(0);
    },
  );
});
