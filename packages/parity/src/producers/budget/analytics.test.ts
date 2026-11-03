/// <reference types="node" />
import { D, investments as inv } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { syntheticDataset } from "../../sources/testing.ts";
import type { StrategyInputsByProfile } from "../investments/strategy.ts";
import { dumps } from "../output.ts";
import { produceBudgetAnalytics } from "./analytics.ts";
import { produceBudgetMonthClose } from "./monthClose.ts";

// Profile 1 (base PLN, budget + investments): a checking account with a monthly NETFLIX, salary and
// a transfer to its own savings account (a matched pair left uncategorized), a cash leg mirroring an ATM withdrawal into
// the pool; a savings balance before September. Profile 2 (base EUR, no rows). Invented values.
const SEED = `
INSERT INTO profiles VALUES (1, 'test-a', 'Test A', 'PLN', 'strict', '2026-01-01 00:00:00');
INSERT INTO profiles VALUES (2, 'test-b', 'Test B', 'EUR', 'strict', '2026-01-01 00:00:00');
INSERT INTO profile_modules VALUES (1, 'budget', 1, '2026-01-01 00:00:00'), (1, 'investments', 1, '2026-01-01 00:00:00'),
  (2, 'budget', 1, '2026-01-01 00:00:00');
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', '10000000000000000000000001', 'csv:1', 'PLN', 'checking', 1, '2026-01-01 00:00:00', 1, NULL),
  (2, 'erste', 'Oszczednosci Test', '10000000000000000000000002', 'csv:2', 'PLN', 'savings', 1, '2026-01-01 00:00:00', 1, NULL),
  (3, 'manual', 'Gotówka', NULL, 'cash:PLN', 'PLN', 'cash', 1, '2026-01-01 00:00:00', 1, NULL);
INSERT INTO balances VALUES (1, 2, '2026-08-31', '1000.00', 'PLN', 'CSV', '2026-08-31 00:00:00');
INSERT INTO transactions (id, account_id, booking_date, value_date, amount, currency,
  counterparty_name, counterparty_iban, description, reference, source, dedup_hash,
  occurrence, transfer_group_id, is_internal_transfer, category, category_source,
  bank_transaction_id, created_at) VALUES
  (1, 1, '2026-07-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h1', 0, NULL, 0, 'subscriptions', 'keyword', NULL, '2026-07-07 00:00:00'),
  (2, 1, '2026-08-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h2', 0, NULL, 0, 'subscriptions', 'keyword', NULL, '2026-08-07 00:00:00'),
  (3, 1, '2026-09-07', NULL, '-43.00', 'PLN', NULL, NULL, 'NETFLIX.COM', 'NETFLIX.COM', 'CSV', 'h3', 0, NULL, 0, 'subscriptions', 'keyword', 'NR 3', '2026-09-07 00:00:00'),
  (4, 1, '2026-09-10', NULL, '5000.00', 'PLN', 'PRACODAWCA TEST', NULL, 'PENSJA', 'PENSJA', 'CSV', 'h4', 0, NULL, 0, 'income_salary', 'keyword', NULL, '2026-09-10 00:00:00'),
  (5, 1, '2026-09-11', NULL, '-500.00', 'PLN', NULL, '10000000000000000000000002', 'P', 'P', 'CSV', 'h5', 0, 'g1', 1, NULL, NULL, NULL, '2026-09-11 00:00:00'),
  (6, 2, '2026-09-11', NULL, '500.00', 'PLN', NULL, '10000000000000000000000001', 'P', 'P', 'CSV', 'h6', 0, 'g1', 1, NULL, NULL, NULL, '2026-09-11 00:00:00'),
  (7, 1, '2026-09-15', NULL, '-100.00', 'PLN', NULL, NULL, 'BANKOMAT', 'BANKOMAT', 'CSV', 'h7', 0, NULL, 0, 'cash_withdrawal', 'manual_txn', NULL, '2026-09-15 00:00:00'),
  (8, 3, '2026-09-15', NULL, '100.00', 'PLN', 'Wypłata gotówki', NULL, 'BANKOMAT', 'Wypłata gotówki', 'MANUAL', 'cashleg:7', 0, NULL, 0, 'cash_withdrawal', 'cash_leg', NULL, '2026-09-15 00:00:00');
`;

const STRATEGIES = (key: string): StrategyInputsByProfile =>
  new Map([
    [
      key,
      {
        state: "valid",
        benchmark: null,
        maxPriceAgeDays: 5,
        maxFxAgeDays: 10,
        contributions: { monthlyAmount: D("1000"), dayOfMonth: 10 },
        strategy: { baseCurrency: inv.toCurrency("PLN"), allocation: inv.allocationPlan() },
      },
    ],
  ]);

describe("budget.analytics producer", () => {
  it("writes cashflow, spending, drill-down and recurring per profile and currency", () => {
    const ds = syntheticDataset(SEED, { schema: "genesis" });
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => ({
          tree: JSON.parse(dumps(produceBudgetAnalytics(db))),
          a: db.keys.key("profiles", 1),
          b: db.keys.key("profiles", 2),
          t3: db.keys.key("transactions", 3),
        }),
      );
      const a = out.tree[out.a];
      expect(a.base_currency).toBe("PLN");
      expect(a.reference_date).toBe("2026-09-15");
      expect(a.currencies).toEqual([
        { currency: "PLN", transactions: 8, first: "2026-07-07", last: "2026-09-15" },
      ]);
      const pln = a.per_currency.PLN;
      expect(
        pln.cashflow.map((r: { label: string; expense: string }) => [r.label, r.expense]),
      ).toEqual([
        ["2026-07", "43.00"],
        ["2026-08", "43.00"],
        ["2026-09", "43.00"],
      ]);
      expect(pln.cashflow_with_internal.at(-1)).toMatchObject({
        income: "5500.00",
        expense: "543.00",
      });
      expect(pln.spending_all).toEqual([
        { category: "subscriptions", label: "Subskrypcje", amount: "129.00" },
      ]);
      expect(Object.keys(pln.spending_periods).sort()).toEqual([
        "2026",
        "2026-07",
        "2026-08",
        "2026-09",
        "2026-Q3",
      ]);
      const drill = pln.category_transactions[0];
      expect(drill.rows[0]).toMatchObject({
        id: out.t3,
        details: "nr NR 3", // the description is the title already
        account: "Konto Test",
      });
      expect(a.recurring.map((r: { counterparty: string }) => r.counterparty)).toEqual([
        "NETFLIX.COM",
      ]);
      expect(a.active_recurring).toHaveLength(1);
      expect(a.not_subscription_categories).toContain("loans");
      const b = out.tree[out.b];
      expect([b.base_currency, b.currencies, b.reference_date, b.recurring]).toEqual([
        "EUR",
        [],
        null,
        [],
      ]);
    } finally {
      ds.dispose();
    }
  });
});

describe("budget.month_close producer", () => {
  it("reads budget.json, values the cushion and compares the plan only with investments on", () => {
    const ds = syntheticDataset(SEED, { schema: "genesis" });
    ds.writeFile(
      "profiles/test-a/budget.json",
      JSON.stringify({ cushion: { enabled: true, target_amount: 3000, account_ids: [2] } }),
    );
    try {
      const out = withPythonDb(
        { dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot },
        (db) => {
          const a = db.keys.key("profiles", 1);
          return {
            tree: JSON.parse(dumps(produceBudgetMonthClose(db, STRATEGIES(a)))),
            a,
            b: db.keys.key("profiles", 2),
            savings: db.keys.key("accounts", 2),
          };
        },
      );
      const a = out.tree[out.a];
      expect(a.settings.cushion).toMatchObject({
        enabled: true,
        target_amount: "3000.00",
        account_ids: [out.savings],
      });
      const sept = a.closes["2026-09"];
      // start 1000 + the 500 moved in during September
      expect(sept.raw.cushion).toMatchObject({
        balance: "1500.00",
        missing: "1500.00",
        accounts: [out.savings],
      });
      expect(sept.raw.currencies[0]).toMatchObject({
        income: "5000.00",
        spending: "43.00",
        cushion_top_up: "1500.00",
      });
      expect(sept.api.currencies[0].suggested_transfer).toBe(3457);
      expect(sept.api.investing.comparison).toMatchObject({ status: "covered", difference: 2457 });
      expect(sept.raw.planned).toEqual({
        strategy_state: "valid",
        amount: "1000",
        currency: "PLN",
        day_of_month: 10,
      });
      expect(Object.keys(a.closes)).toHaveLength(7);
      const b = out.tree[out.b];
      expect(b.settings.cushion.enabled).toBe(false);
      expect(b.closes.default.api.investing).toBeNull();
      expect(b.closes.default.raw.planned).toBeNull();
    } finally {
      ds.dispose();
    }
  });
});
