/// <reference types="node" />
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceBudgetDedup } from "./dedup.ts";

const KEY = "2026-08-03|-5.00|PLN|SKLEP TEST|KARTA TEST R1";
const v1 = (accountId: number, key: string) =>
  createHash("sha1").update(`${accountId}|${key}`).digest("hex");

const SEED = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profiles VALUES (2, 'test-a', 'Test A', 'PLN', 'strict', NULL);
INSERT INTO profile_modules VALUES (1, 'budget', 1, NULL), (2, 'budget', 0, NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', NULL, 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'mbank', 'Konto Test', NULL, 'csv:2', 'PLN', 'checking', 1, NULL, 2, NULL);
INSERT INTO transactions VALUES
  (1, 1, '2026-08-03', NULL, '-5.00', 'PLN', 'SKLEP TEST', NULL, 'KARTA TEST', 'r1', 'CSV',
   '${v1(1, KEY)}', 0, NULL, 0, NULL, NULL, NULL),
  (2, 1, '2026-08-03', NULL, '-5.00', 'PLN', 'SKLEP TEST', NULL, 'KARTA TEST', 'r1', 'OPEN_BANKING',
   '${v1(1, KEY)}', 1, NULL, 0, NULL, NULL, NULL),
  (3, 1, '2026-08-04', NULL, '-1.00', 'PLN', NULL, NULL, 'GOTOWKA', NULL, 'MANUAL', 'cashleg:1', 0,
   NULL, 0, NULL, NULL, NULL),
  (4, 1, '2026-08-05', NULL, '-2.00', 'PLN', NULL, NULL, 'X', NULL, 'CSV', '${"0".repeat(40)}', 0,
   NULL, 0, NULL, NULL, NULL),
  (5, 2, '2026-08-03', NULL, '-5.00', 'PLN', 'SKLEP TEST', NULL, 'KARTA TEST', 'r1', 'CSV',
   '${v1(2, KEY)}', 0, NULL, 0, NULL, NULL, NULL);
`;

describe("budget.dedup producer", () => {
  it("recomputes v2, numbers identical rows and checks v1, per budget profile and account", () => {
    const ds = syntheticDataset(SEED);
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => {
          const tree = JSON.parse(dumps(produceBudgetDedup(db)));
          return { tree, profile: db.keys.key("profiles", 1), account: db.keys.key("accounts", 1) };
        },
      );
      expect(Object.keys(out.tree)).toEqual([out.profile]); // profile 2 has budget disabled
      const acc = out.tree[out.profile][out.account];
      const v2 = createHash("sha1").update(KEY).digest("hex");
      expect(acc.non_content_rows).toBe(1);
      expect(
        acc.rows.map((r: { hash_v2: string; occurrence: number; v1_ok: boolean }) => [
          r.hash_v2 === v2,
          r.occurrence,
          r.v1_ok,
        ]),
      ).toEqual([
        [true, 0, true],
        [true, 1, true],
        [false, 0, false],
      ]);
    } finally {
      ds.dispose();
    }
  });
});
