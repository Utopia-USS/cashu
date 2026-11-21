// Property search over random budget scripts for the effective categories (fast tier, S24c):
// permutations and duplicates give one view hash, the derived oracle holds after every batch, the
// categories equal the domain recompute (D-24.1), rebuild == incremental. The long search over many
// seeds is categories.property.exhaustive.test.ts.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoriesProperty } from "../../testing/category-script.js";

describe("property: effective categories on random synthetic budget scripts", () => {
  it.each([0, 1, 2])("orders, derived oracle, recompute, rebuild: seed slice %i", (i) => {
    fc.assert(categoriesProperty, { numRuns: 6, seed: 70_000 + i });
  });
});
