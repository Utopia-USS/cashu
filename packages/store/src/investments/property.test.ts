// Property test (S25 spec 7.2): random investments event sets over a colliding universe converge in
// every delivery order, rebuild to the incremental view, and equal the reference fold. The long search over many seeds is
// property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { convergesProperty, referenceProperty } from "./testing/property-script.js";

describe("investments property: convergence on random synthetic event sets", () => {
  it("permutations and duplicates give identical view hashes; rebuild == incremental", () => {
    fc.assert(convergesProperty, { numRuns: 30 });
  });

  it("the store's investments tables equal the reference fold's", () => {
    fc.assert(referenceProperty, { numRuns: 30 });
  });
});
