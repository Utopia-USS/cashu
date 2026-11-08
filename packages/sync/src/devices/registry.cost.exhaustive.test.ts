// Exhaustive tier: registry fold cost with many devices (review M4, A7 / A8; A8 measured 21 s for 150
// puppets before S29b). Work is counted, never timed: a return to quadratic folds shows as checks far
// above linear in the certificates. The default tier runs the 70-puppet case (registry.cost.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import {
  foldTwice,
  puppetsRevokedOneByOne,
  type Scenario,
  twoLevelTree,
} from "../testing/devices/registryCost.js";

function expectLinear(s: Scenario, label: string) {
  const { cold, warm } = foldTwice(s);
  console.log(
    `${label}: certs ${s.certificates}, events ${s.events.length}; cold checks ${cold.certificateChecks}, cold cert verifications ${cold.certificateVerifications}, cold statement checks ${cold.statementChecks}; warm checks ${warm.certificateChecks}, warm cert verifications ${warm.certificateVerifications}`,
  );
  expect(warm.certificateVerifications).toBe(0);
  expect(cold.certificateVerifications).toBeLessThanOrEqual(2 * s.certificates);
  expect(cold.certificateChecks).toBeLessThanOrEqual(20 * s.certificates);
  expect(cold.statementChecks).toBeLessThanOrEqual(3 * s.events.length);
  return cold.registry;
}

// Scenarios are built in `beforeAll` (thousands of signatures) so each test is the fold itself.
describe.each([150, 1000])(
  "A8: one trusted device certifies %i puppets and revokes them one by one",
  (n) => {
    let scenario: Scenario;
    beforeAll(() => {
      scenario = puppetsRevokedOneByOne(n);
    });
    it("folds in linear work; a warm re-fold verifies nothing again", () => {
      expect(expectLinear(scenario, `A8 n=${n}`).revocationCount).toBe(64); // per-signer cap
    });
  },
);

describe("A7: 1000 trusted devices (a two-level tree) with 160 revocations", () => {
  let scenario: Scenario;
  beforeAll(() => {
    scenario = twoLevelTree();
  });
  it("folds in linear work; a warm re-fold verifies nothing again", () => {
    const registry = expectLinear(scenario, "tree");
    expect(registry.trusted.size).toBe(1 + 16 + 16 * 52);
    expect(registry.revocationCount).toBe(160);
  });
});
