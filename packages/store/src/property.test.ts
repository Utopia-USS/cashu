// Property tests on random synthetic event sets (testing/property-script.ts), fast tier: a short
// search on every run. The long search over many seeds is property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { convergesProperty, referenceProperty } from "./testing/property-script.js";

describe("property: convergence on random synthetic event sets", () => {
  it("permutations and duplicates give identical view hashes; derived oracle; rebuild == incremental", () => {
    fc.assert(convergesProperty, { numRuns: 30 });
  });

  it("the store's view equals the reference fold's view", () => {
    fc.assert(referenceProperty, { numRuns: 30 });
  });
});
