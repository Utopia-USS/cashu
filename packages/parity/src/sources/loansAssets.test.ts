// The loans / assets readers (`db.loansAssets`) over a synthetic dataset (invented values): profile
// scoping through the accounts (removed ones included), id order, stored text kept as is.

import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "./pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "./testing.ts";

const SEED = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO profiles VALUES (2, 'test-a', 'Test A', 'PLN', 'strict', NULL);
INSERT INTO accounts VALUES
  (1, 'manual', 'Kredyt Test', NULL, 'manual:kredyt', 'PLN', 'loan', 1, NULL, 1, NULL),
  (2, 'manual', 'Auto Test', NULL, 'vehicle:Auto Test', 'PLN', 'vehicle', 1, NULL, 1,
   '2026-06-01 10:00:00'),
  (3, 'manual', 'Kredyt Inny Test', NULL, 'manual:inny', 'PLN', 'mortgage', 1, NULL, 2, NULL),
  (4, 'mbank', 'Konto Test', NULL, 'csv:4', 'PLN', 'checking', 1, NULL, 1, NULL);
INSERT INTO loans (id, account_id, principal, annual_rate, term_months, start_date, origination_date,
  created_at, updated_at, payment_iban, payment_text) VALUES
  (2, 1, '1000.50', '6.27', 12, '2026-02-05', '2026-01-20', '2026-01-01 00:00:00.000000',
   '2026-01-02 00:00:00.000000', NULL, 'RATA TEST'),
  (1, 3, '5000', '0', 6, '2026-01-01', NULL, '2026-01-01 00:00:00.000000',
   '2026-01-01 00:00:00.000000', 'PL01', NULL);
INSERT INTO depreciations VALUES (1, 2, '80000', '2025-05-01', '15', '10000', NULL),
  (2, 3, '1', '2025-01-01', '1', NULL, NULL);
INSERT INTO asset_details VALUES (1, 2, 'Notatka test', NULL, NULL), (2, 3, 'Inny test', NULL, NULL);
INSERT INTO balances VALUES
  (1, 4, '2026-09-01', '1.00', 'PLN', 'CSV', NULL),
  (2, 1, '2026-03-01', '900.00', 'PLN', 'MANUAL', '2026-03-01 08:00:00.000000'),
  (3, 1, '2026-02-01', '950.00', 'PLN', 'CSV', '2026-02-01 08:00:00.000000'),
  (4, 3, '2026-02-01', '4000.00', 'PLN', 'CSV', '2026-02-01 08:00:00.000000');
`;

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

describe("LoansAssetsReader", () => {
  it("reads one profile's loans, curves, notes and loan balances", () => {
    ds = syntheticDataset(SEED);
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      expect(db.loansAssets.loans(1)).toEqual([
        {
          id: 2,
          accountId: 1,
          principal: "1000.50",
          annualRate: "6.27",
          termMonths: 12,
          startDate: "2026-02-05",
          originationDate: "2026-01-20",
          createdAt: "2026-01-01 00:00:00.000000",
          updatedAt: "2026-01-02 00:00:00.000000",
          paymentIban: null,
          paymentText: "RATA TEST",
        },
      ]);
      expect(db.loansAssets.loans(2).map((l) => l.id)).toEqual([1]);
      // the removed vehicle's curve and note are still read (the module code drops removed accounts)
      expect(db.loansAssets.depreciations(1)).toEqual([
        {
          id: 1,
          accountId: 2,
          purchasePrice: "80000",
          purchaseDate: "2025-05-01",
          annualRate: "15",
          floor: "10000",
        },
      ]);
      expect(db.loansAssets.assetDetails(1)).toEqual([
        { id: 1, accountId: 2, note: "Notatka test" },
      ]);
      // only the loan accounts' balances, by account then id; the bank account's row is not read
      expect(db.loansAssets.loanAccountBalances(1).map((b) => [b.id, b.date, b.createdAt])).toEqual(
        [
          [2, "2026-03-01", "2026-03-01 08:00:00.000000"],
          [3, "2026-02-01", "2026-02-01 08:00:00.000000"],
        ],
      );
      expect(db.loansAssets.loanAccountBalances(2).map((b) => b.id)).toEqual([4]);
      expect(db.loanPaymentPatterns(1)).toEqual([
        { category: "loans", counterpartyIban: null, text: "RATA TEST" },
      ]);
    });
  });
});
