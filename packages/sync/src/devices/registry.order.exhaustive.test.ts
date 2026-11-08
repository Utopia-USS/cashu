// Exhaustive tier: the registry's order-freedom sweep (seeds 4-25; the default tier runs 1-3 in
// registry.test.ts). One test per seed, each a single fold over a shared scenario.

import { beforeAll, describe, it } from "vitest";
import {
  expectOrderFree,
  mutualRevocationScenario,
  type OrderScenario,
} from "../testing/devices/registryOrder.js";

describe("device registry: the fold depends only on the set of events (sweep)", () => {
  let scenario: OrderScenario;
  beforeAll(async () => {
    scenario = await mutualRevocationScenario();
  });
  it.each(Array.from({ length: 22 }, (_, i) => i + 4))("seed %i", (seed) => {
    expectOrderFree(scenario, seed);
  });
});
