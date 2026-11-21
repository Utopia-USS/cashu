// Convergence property on random synthetic event sets (testing/property-script.ts), fast tier: a
// short search on every run. The long search over many seeds is property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { convergesProperty } from "./testing/property-script.js";

describe("property: convergence on random synthetic event sets", () => {
  it("permutations and duplicates give identical view hashes; derived oracle; rebuild == incremental", () => {
    fc.assert(convergesProperty, { numRuns: 30 });
  });
});
