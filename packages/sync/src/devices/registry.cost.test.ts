// Registry fold cost, small case (review M4, A8): a device certifies 70 puppets (past the per-issuer
// quota) and revokes them one by one. Work is counted, never timed; the large cases (150 and 1000
// puppets, a 1000-device tree) are registry.cost.exhaustive.test.ts.

import { describe, expect, it } from "vitest";
import { foldTwice, puppetsRevokedOneByOne } from "./registryCost.js";

describe("registry fold cost (M4)", () => {
  it("A8 (70 puppets): linear work, and a warm re-fold verifies nothing again", () => {
    const s = puppetsRevokedOneByOne(70);
    const { cold, warm } = foldTwice(s);
    console.log(`A8 n=70: cold ${JSON.stringify({ ...cold, registry: undefined })}`);
    expect(cold.registry.revocationCount).toBe(64); // per-signer cap
    expect(warm.registry.revocationCount).toBe(64);
    expect(warm.certificateVerifications).toBe(0);
    expect(cold.certificateVerifications).toBeLessThanOrEqual(2 * s.certificates);
    expect(cold.certificateChecks).toBeLessThanOrEqual(20 * s.certificates);
    expect(cold.statementChecks).toBeLessThanOrEqual(3 * s.events.length);
  });
});
