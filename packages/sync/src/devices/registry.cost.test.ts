// Registry fold cost, small cases (review M4, A8 / H1). Work is counted, never timed: the marginal
// work per added certificate stays bounded (a quadratic fold shows as a marginal cost growing with
// the size). The large cases (150 and 1000 puppets, a 1000-device tree) are
// registry.cost.exhaustive.test.ts; the per-signer revocation cap is registry.test.ts.

import { describe, expect, it } from "vitest";
import {
  foldTwice,
  puppetDefeatChain,
  puppetsRevokedOneByOne,
} from "../testing/devices/registryCost.js";

describe("registry fold cost (M4)", () => {
  it("A8: work per added puppet stays constant, and a warm re-fold verifies nothing again", () => {
    const small = puppetsRevokedOneByOne(5);
    const big = puppetsRevokedOneByOne(20);
    const [s, b] = [foldTwice(small), foldTwice(big)];
    expect(b.cold.registry.revocationCount).toBe(20);
    expect(b.warm.certificateVerifications).toBe(0);
    const certs = big.certificates - small.certificates;
    const events = big.events.length - small.events.length;
    expect(b.cold.certificateVerifications - s.cold.certificateVerifications).toBeLessThanOrEqual(
      2 * certs,
    );
    expect(b.cold.certificateChecks - s.cold.certificateChecks).toBeLessThanOrEqual(20 * certs);
    expect(b.cold.statementChecks - s.cold.statementChecks).toBeLessThanOrEqual(3 * events);
  });
});

describe("H1: a defeat chain of a revoked device's puppets costs nothing once it is revoked", () => {
  it("no statement of a puppet is even checked: the fold's work does not grow with the chain", () => {
    const work = (k: number) => foldTwice(puppetDefeatChain(k)).warm.statementChecks;
    // 8 more puppets: one statement check each for their own `device.added` (pre-cut, legitimate
    // names); their revocations (a signature and a consent check each) are never even checked.
    expect(work(12) - work(4)).toBeLessThanOrEqual(8 + 2);
  });
});
