// Exhaustive tier: registry fold cost with many devices (review M4, A7 / A8; A8 measured 21 s for 150
// puppets before S29b). Work is counted, never timed: a return to quadratic folds shows as checks far
// above linear in the certificates. The default tier runs the 70-puppet case (registry.cost.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import {
  type FoldCost,
  folds,
  puppetsRevokedOneByOne,
  type Scenario,
  twoLevelTree,
} from "../testing/devices/registryCost.js";

function expectLinearCold(s: Scenario, cold: FoldCost, label: string) {
  console.log(
    `${label}: certs ${s.certificates}, events ${s.events.length}; cold checks ${cold.certificateChecks}, cold cert verifications ${cold.certificateVerifications}, cold statement checks ${cold.statementChecks}`,
  );
  expect(cold.certificateVerifications).toBeLessThanOrEqual(2 * s.certificates);
  expect(cold.certificateChecks).toBeLessThanOrEqual(20 * s.certificates);
  expect(cold.statementChecks).toBeLessThanOrEqual(3 * s.events.length);
}

// Scenarios are built in `beforeAll` (thousands of signatures). The cold fold and the warm re-fold are
// two tests in order on one shared cache, so each test is one fold.
describe.each([150, 1000])(
  "A8: one trusted device certifies %i puppets and revokes them one by one",
  (n) => {
    let scenario: Scenario;
    let fold: () => FoldCost;
    beforeAll(() => {
      scenario = puppetsRevokedOneByOne(n);
      fold = folds(scenario);
    });
    it("folds in linear work", () => {
      const cold = fold();
      expectLinearCold(scenario, cold, `A8 n=${n}`);
      expect(cold.registry.revocationCount).toBe(64); // per-signer cap
    });
    it("a warm re-fold verifies nothing again", () => {
      const warm = fold();
      expect(warm.certificateVerifications).toBe(0);
      expect(warm.registry.revocationCount).toBe(64);
    });
  },
);

describe("A7: 1000 trusted devices (a two-level tree) with 160 revocations", () => {
  let scenario: Scenario;
  let fold: () => FoldCost;
  beforeAll(() => {
    scenario = twoLevelTree();
    fold = folds(scenario);
  });
  it("folds in linear work", () => {
    const cold = fold();
    expectLinearCold(scenario, cold, "tree");
    expect(cold.registry.trusted.size).toBe(1 + 16 + 16 * 52);
    expect(cold.registry.revocationCount).toBe(160);
  });
  it("a warm re-fold verifies nothing again", () => {
    const warm = fold();
    expect(warm.certificateVerifications).toBe(0);
    expect(warm.registry.trusted.size).toBe(1 + 16 + 16 * 52);
    expect(warm.registry.revocationCount).toBe(160);
  });
});
