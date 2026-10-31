// Property test (S25 spec 7.2): random investments event sets over a colliding universe converge in
// every delivery order and rebuild to the incremental view. The long search over many seeds is
// property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { convergesProperty } from "./property-script.js";

describe("investments property: convergence on random synthetic event sets", () => {
  it("permutations and duplicates give identical view hashes; rebuild == incremental", () => {
    fc.assert(convergesProperty, { numRuns: 30 });
  });
});
