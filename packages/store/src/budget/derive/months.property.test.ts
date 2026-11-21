// Property search over random budget scripts for the month aggregates (M3, fast tier): imports and
// re-imports, claims, merchant rules, cash expenses and deletes, cash withdrawals (legs), account
// merges, removals and type changes (the categories script), and transfers forming and dissolving
// (the transfers script). After every batch the `budget.months` tables equal the recompute from every
// row, the incremental derivation equals `deriveAll` (`rederive`), and the aggregate-based month
// figures and balances equal the book-based ones; a rebuild keeps the tables. The long search over
// many seeds is months.property.exhaustive.test.ts. Synthetic data only.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { monthsProperty } from "../../testing/months-oracle.js";
import { transferScript } from "../../testing/transfer-script.js";

describe("property: month aggregates on random synthetic budget scripts", () => {
  it.each([0, 1, 2])("categories script: recompute, rederive, book queries: seed %i", (i) => {
    fc.assert(monthsProperty(categoryScript), { numRuns: 6, seed: 90_000 + i });
  });

  it.each([0, 1, 2])("transfers script: recompute, rederive, book queries: seed %i", (i) => {
    fc.assert(monthsProperty(transferScript), { numRuns: 6, seed: 91_000 + i });
  });
});
