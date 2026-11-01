/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceBudgetCategories } from "./categories.ts";

// Profile 1: a checking account, a cash pool and a loan (lender account), NETFLIX monthly (a
// subscription), an own-account move matched by S08, an llm_full row a locked rule overrides, a
// manual_txn row and an undecided cash row (D-09.4). Profile 2 shares nothing.
const SEED = `
INSERT INTO profiles VALUES (1, 'test-a', 'Test A', 'PLN', 'strict', NULL);
INSERT INTO profiles VALUES (2, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profile_modules VALUES (1, 'budget', 1, NULL), (2, 'budget', 1, NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', '10000000000000000000000001', 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'manual', 'Gotówka', NULL, 'cash:PLN', 'PLN', 'cash', 1, NULL, 1, NULL),
  (3, 'pekao', 'Konto Test', '10000000000000000000000003', 'csv:3', 'PLN', 'savings', 1, NULL, 1, NULL),
  (4, 'manual', 'Kredyt Test', NULL, 'manual:k', 'PLN', 'loan', 1, NULL, 1, NULL),
  (5, 'mbank', 'Konto Test', '10000000000000000000000005', 'csv:5', 'PLN', 'checking', 1, NULL, 2, NULL);
INSERT INTO loans VALUES (1, 4, '99 1600 0000 0000 0000 0000 0999', NULL);
INSERT INTO category_rules VALUES (1, 'SKLEP LOCKED TEST', 'gifts', 'manual', 1, NULL, 1);
INSERT INTO transactions VALUES
  (1, 1, '2026-05-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h1', 0, NULL, 0, NULL, NULL),
  (2, 1, '2026-06-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h2', 0, NULL, 0, NULL, NULL),
  (3, 1, '2026-07-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h3', 0, NULL, 0, NULL, NULL),
  (4, 1, '2026-07-10', NULL, '-1081.94', 'PLN', 'FINANSE TEST', '99160000000000000000000999', 'P', 'P', 'CSV', 'h4', 0, NULL, 0, 'other', 'default'),
  (5, 1, '2026-07-11', NULL, '-100.00', 'PLN', NULL, '10000000000000000000000003', 'P', 'P', 'CSV', 'h5', 0, NULL, 0, NULL, NULL),
  (6, 3, '2026-07-11', NULL, '100.00', 'PLN', NULL, NULL, 'P', 'P', 'CSV', 'h6', 0, NULL, 0, NULL, NULL),
  (7, 1, '2026-07-12', NULL, '-9.00', 'PLN', 'SKLEP LOCKED TEST', NULL, NULL, NULL, 'CSV', 'h7', 0, NULL, 0, 'travel', 'llm_full'),
  (8, 1, '2026-07-13', NULL, '-9.00', 'PLN', 'ZABKA', NULL, NULL, NULL, 'CSV', 'h8', 0, NULL, 0, 'dining', 'manual_txn'),
  (9, 2, '2026-07-14', NULL, '-5.00', 'PLN', NULL, NULL, 'KAWA', NULL, 'MANUAL', 'h9', 0, NULL, 0, 'other', 'default'),
  (10, 5, '2026-07-14', NULL, '-5.00', 'PLN', NULL, NULL, 'NETFLIX.COM', NULL, 'CSV', 'h10', 0, NULL, 0, NULL, NULL);
`;

describe("budget.categories producer", () => {
  it("recomputes every row over transfers, rules, loan patterns and claims, per profile", () => {
    const ds = syntheticDataset(SEED);
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => ({
          tree: JSON.parse(dumps(produceBudgetCategories(db))),
          a: db.keys.key("profiles", 1),
          b: db.keys.key("profiles", 2),
        }),
      );
      const a = out.tree[out.a];
      expect(
        a.rows.map((r: { category: string | null; category_source: string | null }) => [
          r.category,
          r.category_source,
        ]),
      ).toEqual([
        ["subscriptions", "keyword"],
        ["subscriptions", "keyword"],
        ["subscriptions", "keyword"],
        ["loans", "keyword"],
        ["transfer", "transfer"],
        ["transfer", "transfer"],
        ["gifts", "manual"],
        ["dining", "manual_txn"],
        [null, null],
      ]);
      expect(a.subscription_payees).toEqual(["NETFLIX.COM"]);
      expect(a.recurring).toHaveLength(1);
      expect(a.cash_unclaimed).toBe(1);
      expect(a.drift).toEqual({
        null: { changed: 5, same: 0 },
        default: { changed: 2, same: 0 },
        llm_full: { changed: 1, same: 0 },
        manual_txn: { changed: 0, same: 1 },
      });
      expect(out.tree[out.b].rows).toHaveLength(1);
      expect(out.tree[out.b].subscription_payees).toEqual([]);
    } finally {
      ds.dispose();
    }
  });
});
