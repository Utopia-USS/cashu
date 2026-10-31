// The core.networth producer over a synthetic dataset and a synthetic bridge (invented values).

import { describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { syntheticDataset } from "../../sources/testing.ts";
import type { BridgeFile } from "./bridge.ts";
import { produceNetworth } from "./networth.ts";

const SEED = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', NULL, 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'manual', 'Gotówka', NULL, NULL, 'PLN', 'cash', 1, NULL, 1, NULL),
  (3, 'manual', 'Kredyt Test', NULL, 'manual:kredyt', 'PLN', 'loan', 1, NULL, 1, NULL),
  (4, 'manual', 'Konto EUR Test', NULL, 'manual:eur', 'EUR', 'savings', 1, NULL, 1, NULL),
  (5, 'manual', 'Pusta Gotówka', NULL, 'manual:cash2', 'PLN', 'cash', 1, NULL, 1, NULL);
INSERT INTO balances VALUES
  (1, 1, '2026-09-01', '1000.00', 'PLN', 'CSV', NULL),
  (2, 1, '2026-09-01', '1100.00', 'PLN', 'OPEN_BANKING', NULL),
  (3, 3, '2026-01-01', '9000.00', 'PLN', 'MANUAL', NULL),
  (4, 4, '2025-06-01', '10.00', 'EUR', 'MANUAL', NULL);
INSERT INTO transactions VALUES
  (1, 2, '2026-08-02', NULL, '200.00', 'PLN', NULL, NULL, 'WYPLATA TEST', NULL, 'MANUAL', 'h1', 1,
   NULL, 0, 'cash', 'manual'),
  (2, 2, '2026-08-01', NULL, '-20.50', 'PLN', NULL, NULL, 'SKLEP TEST', NULL, 'MANUAL', 'h2', 1,
   NULL, 0, 'groceries', 'manual');
`;

describe("core.networth producer", () => {
  it("values every account by its owner and keeps currencies apart", () => {
    const ds = syntheticDataset(SEED);
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => {
          const profile = db.keys.key("profiles", 1);
          const loan = db.keys.key("accounts", 3);
          const bridge: BridgeFile = {
            [profile]: {
              year_ago: "2025-10-01",
              modules: {
                loans: {
                  [loan]: {
                    now: { as_of: "2026-10-01", amount: "8000.00" },
                    year_ago: { as_of: "2025-10-01", amount: "9500.00" },
                  },
                },
              },
            },
          };
          return { value: produceNetworth(db, bridge), profile, loan };
        },
      );
      const p = (out.value as Record<string, Record<string, unknown>>)[out.profile];
      // checking 1100 (OB wins) + cash 179.50 - loan 8000 (bridge beats the 9000 snapshot)
      expect(JSON.parse(JSON.stringify(p?.totals))).toEqual({ PLN: "-6720.50", EUR: "10.00" });
      // a year ago: no checking or cash yet, loan 9500, EUR snapshot from 2025-06
      expect(JSON.parse(JSON.stringify(p?.totals_365d_ago))).toEqual({
        PLN: "-9500.00",
        EUR: "10.00",
      });
      const lines = JSON.parse(JSON.stringify(p?.lines)) as {
        type: string;
        amount: string | null;
      }[];
      expect(lines.map((l) => [l.type, l.amount])).toEqual([
        ["checking", "1100.00"],
        ["cash", "179.50"],
        ["loan", "8000.00"],
        ["savings", "10.00"],
        ["cash", "0.00"], // a cash pool without movements is worth 0.00
      ]);
      const pln = JSON.parse(JSON.stringify(p?.breakdown)).PLN;
      expect(pln).toMatchObject({ assets: "1279.50", liabilities: "8000.00", net: "-6720.50" });
      expect(p?.liability_components).toEqual(["loan", "mortgage"]);
    } finally {
      ds.dispose();
    }
  });
});
