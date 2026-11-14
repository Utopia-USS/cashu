// Exhaustive tier: the delivery-order property of the review attacks over ten seeds, one test per
// seed (attacks.test.ts runs seed 1 in the default tier).

import { describe, it } from "vitest";
import { deliveryOrderRun } from "../testing/devices/orderSim.js";

describe("review attacks: any delivery order, every seed", () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("seed %i", async (seed) => {
    await deliveryOrderRun(seed);
  });
});
