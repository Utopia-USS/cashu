// Property search over random budget scripts for the recurring payments (M3, fast tier): the
// recurring script (monthly charges, drift, price rises, one-off purchases, claims, rules, cash rows
// judged by the engine, removals), the categories and the transfers scripts. After every batch
// `fold_recurring` equals the recompute from the book, the incremental derivation equals `deriveAll`
// (`rederive`), and `recurringCharges` / `payeeChargeHistories` equal the book-based reads on days
// before, inside and after the data; a rebuild keeps the tables. The long search over many seeds is
// recurring.property.exhaustive.test.ts. Synthetic data only.
import fc from "fast-check";
import { describe, it } from "vitest";
import { categoryScript } from "../../testing/category-script.js";
import { recurringProperty } from "../../testing/recurring-oracle.js";
import { recurringScript } from "../../testing/recurring-script.js";
import { transferScript } from "../../testing/transfer-script.js";

describe("property: recurring payments on random synthetic budget scripts", () => {
  it.each([0, 1, 2, 3])("recurring script: recompute, rederive, book reads: seed %i", (i) => {
    fc.assert(recurringProperty(recurringScript), { numRuns: 6, seed: 94_000 + i });
  });

  it.each([0, 1])("categories script: recompute, rederive, book reads: seed %i", (i) => {
    fc.assert(recurringProperty(categoryScript), { numRuns: 6, seed: 95_000 + i });
  });

  it.each([0, 1])("transfers script: recompute, rederive, book reads: seed %i", (i) => {
    fc.assert(recurringProperty(transferScript), { numRuns: 6, seed: 96_000 + i });
  });
});
