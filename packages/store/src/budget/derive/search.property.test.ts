// Property search over random budget scripts for the search index (M3, fast tier): imports and
// re-imports, claims, merchant rules, cash expenses and deletes, cash withdrawals (legs), account
// merges, removals and type changes (the categories script), and transfers forming and dissolving
// (the transfers script). After every batch the `budget.search` index equals the recompute from every
// row, the incremental derivation equals `deriveAll` (`rederive`) and `budgetSearch` equals a plain
// filter of the visible rows; a rebuild keeps the index. The long search over many seeds is
// search.property.exhaustive.test.ts. Synthetic data only.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { searchProperty } from "../../testing/search-oracle.js";
import { transferScript } from "../../testing/transfer-script.js";

describe("property: search index on random synthetic budget scripts", () => {
  it.each([0, 1, 2])("categories script: recompute, rederive, queries: seed %i", (i) => {
    fc.assert(searchProperty(categoryScript), { numRuns: 6, seed: 94_000 + i });
  });

  it.each([0, 1, 2])("transfers script: recompute, rederive, queries: seed %i", (i) => {
    fc.assert(searchProperty(transferScript), { numRuns: 6, seed: 95_000 + i });
  });
});
