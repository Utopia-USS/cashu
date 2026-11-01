/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { PYTHON_UNGROUPED_PLAN, produceBudgetTransfers } from "./transfers.ts";

// Account 3 is removed (still an own account, D-08.1); account 4 belongs to profile 2. The outflow
// (id 5) has two candidate inflows on the same day: id 2 on account 3 and id 4 on account 2. Python
// tries them in id order, so id 2 wins; the reader's (account_id, id) order would pick id 4 (R3).
const SEED = `
INSERT INTO profiles VALUES (1, 'test-a', 'Test A', 'PLN', 'strict', NULL);
INSERT INTO profiles VALUES (2, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profile_modules VALUES (1, 'budget', 1, NULL), (2, 'budget', 1, NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', 'PL10000000000000000000000001', 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'erste', 'Konto Test', '10000000000000000000000002', 'csv:2', 'PLN', 'checking', 1, NULL, 1, NULL),
  (3, 'pekao', 'Konto Test', '''10000000000000000000000003', 'csv:3', 'PLN', 'savings', 1, NULL, 1,
   '2026-01-01 00:00:00'),
  (4, 'mbank', 'Konto Test', '10000000000000000000000004', 'csv:4', 'PLN', 'checking', 1, NULL, 2, NULL);
INSERT INTO transactions VALUES
  (2, 3, '2026-08-03', NULL, '100.00', 'PLN', NULL, '10000000000000000000000001', 'P', NULL, 'CSV',
   'h2', 0, NULL, 0, NULL, NULL, NULL),
  (4, 2, '2026-08-03', NULL, '100.00', 'PLN', NULL, NULL, 'P', NULL, 'CSV', 'h4', 0, 'g1', 1, NULL, NULL, NULL),
  (5, 1, '2026-08-03', NULL, '-100.00', 'PLN', NULL, 'PL10 0000 0000 0000 0000 0000 0002', 'P', NULL,
   'CSV', 'h5', 0, 'g1', 1, NULL, NULL, NULL),
  (6, 4, '2026-08-03', NULL, '-100.00', 'PLN', NULL, '10000000000000000000000001', 'P', NULL, 'CSV',
   'h6', 0, NULL, 0, NULL, NULL, NULL);
`;

describe("budget.transfers producer", () => {
  it("matches in id order over every own account, per profile, and reports drift from stored groups", () => {
    const ds = syntheticDataset(SEED);
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => ({
          tree: JSON.parse(dumps(produceBudgetTransfers(db))),
          a: db.keys.key("profiles", 1),
          b: db.keys.key("profiles", 2),
          t: (id: number) => db.keys.key("transactions", id),
        }),
      );
      expect(Object.keys(out.tree).sort()).toEqual([out.a, out.b].sort());
      const a = out.tree[out.a];
      expect(a.pairs).toBe(1);
      expect(a.groups).toEqual([[out.t(5), out.t(2)]]);
      expect(a.drift).toEqual({
        only_stored: 1,
        only_recompute: 1,
        same: 0,
        stored_flagged_rows: 2,
      });
      expect(a.plan).toBe(PYTHON_UNGROUPED_PLAN);
      // profile 2's outflow names profile 1's account but its rows never see profile 1's.
      expect(out.tree[out.b].pairs).toBe(0);
      expect(out.tree[out.b].groups).toEqual([]);
      expect(a).not.toHaveProperty("skipped_non_finite");
    } finally {
      ds.dispose();
    }
  });

  it("skips and counts non-finite amounts (Q14) instead of crashing", () => {
    const ds = syntheticDataset(`${SEED}
INSERT INTO transactions VALUES
  (7, 1, '2026-08-03', NULL, 'NaN', 'PLN', NULL, NULL, 'P', NULL, 'MANUAL', 'h7', 0, NULL, 0, NULL, NULL, NULL),
  (8, 2, '2026-08-03', NULL, '-Infinity', 'PLN', NULL, NULL, 'P', NULL, 'MANUAL', 'h8', 0, NULL, 0, NULL,
   NULL, NULL);`);
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => ({
          tree: JSON.parse(dumps(produceBudgetTransfers(db))),
          a: db.keys.key("profiles", 1),
          t: (id: number) => db.keys.key("transactions", id),
        }),
      );
      const a = out.tree[out.a];
      expect(a.groups).toEqual([[out.t(5), out.t(2)]]);
      expect(a.skipped_non_finite).toBe(2);
    } finally {
      ds.dispose();
    }
  });
});
