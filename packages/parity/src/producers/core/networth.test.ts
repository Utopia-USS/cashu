// The core.networth, core.networth_series, loans.valuation and assets.depreciation producers over one
// synthetic dataset (invented values): every module's TS contributor, no Python input.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PythonDb, withPythonDb } from "../../sources/index.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { produceAssetsDepreciation } from "../assets/depreciation.ts";
import { produceLoansValuation } from "../loans/valuation.ts";
import { dumps, type OutValue } from "../output.ts";
import { produceNetworth } from "./networth.ts";
import { produceNetworthSeries } from "./networthSeries.ts";

// Loan (account 3): 12000 at 0 % over 24 months from 2025-01-01 (500 a month), terms set 2026-01-01;
// the 9000 placeholder was recorded before the terms (superseded), the 4000 statement of 2026-06-01
// after them (it wins from its date on). Vehicle (account 6): bought on as_of for 10000.
const SEED = `
INSERT INTO profiles VALUES (1, 'test-b', 'Test B', 'PLN', 'strict', NULL);
INSERT INTO accounts VALUES
  (1, 'mbank', 'Konto Test', NULL, 'csv:1', 'PLN', 'checking', 1, NULL, 1, NULL),
  (2, 'manual', 'Gotówka', NULL, NULL, 'PLN', 'cash', 1, NULL, 1, NULL),
  (3, 'manual', 'Kredyt Test', NULL, 'manual:kredyt', 'PLN', 'loan', 1, NULL, 1, NULL),
  (4, 'manual', 'Konto EUR Test', NULL, 'manual:eur', 'EUR', 'savings', 1, NULL, 1, NULL),
  (5, 'manual', 'Pusta Gotówka', NULL, 'manual:cash2', 'PLN', 'cash', 1, NULL, 1, NULL),
  (6, 'manual', 'Auto Test', NULL, 'vehicle:Auto Test', 'PLN', 'vehicle', 1, NULL, 1, NULL);
INSERT INTO balances VALUES
  (1, 1, '2026-09-01', '1000.00', 'PLN', 'CSV', NULL),
  (2, 1, '2026-09-01', '1100.00', 'PLN', 'OPEN_BANKING', NULL),
  (3, 3, '2026-01-01', '9000.00', 'PLN', 'MANUAL', '2025-12-01 00:00:00.000000'),
  (4, 4, '2025-06-01', '10.00', 'EUR', 'MANUAL', NULL),
  (5, 3, '2026-06-01', '4000.00', 'PLN', 'CSV', '2026-06-02 08:00:00.000000');
INSERT INTO loans (id, account_id, principal, annual_rate, term_months, start_date, updated_at,
  payment_iban) VALUES (1, 3, '12000', '0', 24, '2025-01-01', '2026-01-01 00:00:00.000000', 'PL001234');
INSERT INTO depreciations VALUES (1, 6, '10000', '2026-10-01', '15', NULL, NULL);
INSERT INTO asset_details VALUES (1, 6, 'Notatka test', NULL, NULL);
INSERT INTO transactions VALUES
  (1, 2, '2026-08-02', NULL, '200.00', 'PLN', NULL, NULL, 'WYPLATA TEST', NULL, 'MANUAL', 'h1', 1,
   NULL, 0, 'cash', 'manual', NULL),
  (2, 2, '2026-08-01', NULL, '-20.50', 'PLN', NULL, NULL, 'SKLEP TEST', NULL, 'MANUAL', 'h2', 1,
   NULL, 0, 'groceries', 'manual', NULL);
`;

type Tree = Record<string, unknown>;

let ds: SyntheticDataset;
beforeEach(() => {
  ds = syntheticDataset(SEED);
});
afterEach(() => ds.dispose());

/** Run a producer and return the profile's subtree as plain JSON plus a key lookup. */
function run(produce: (db: PythonDb) => OutValue) {
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    const tree = JSON.parse(dumps(produce(db))) as Tree;
    const account = (id: number) => db.keys.key("accounts", id);
    return { p: tree[db.keys.key("profiles", 1)], account, loan: db.keys.key("loans", 1) };
  });
}

describe("core.networth producer", () => {
  it("values every account by its owner and keeps currencies apart", () => {
    const { p: profile } = run(produceNetworth);
    const p = profile as Tree;
    // checking 1100 (OB wins) + cash 179.50 - loan 2000 (statement 4000 less 2000 repaid since)
    // + vehicle 10000.0 (bought today)
    expect(p.totals).toEqual({ PLN: "9279.50", EUR: "10.00" });
    // a year ago: no checking, cash or car yet; the loan by its schedule (10 of 24 paid)
    expect(p.totals_365d_ago).toEqual({ PLN: "-7000.00", EUR: "10.00" });
    const lines = p.lines as { type: string; amount: string | null }[];
    expect(lines.map((l) => [l.type, l.amount])).toEqual([
      ["checking", "1100.00"],
      ["cash", "179.50"],
      ["loan", "2000.00"],
      ["savings", "10.00"],
      ["cash", "0.00"], // a cash pool without movements is worth 0.00
      ["vehicle", "10000.0"],
    ]);
    expect((p.breakdown as Tree).PLN).toMatchObject({
      assets: "11279.50",
      liabilities: "2000.00",
      net: "9279.50",
    });
    expect(p.liability_components).toEqual(["loan", "mortgage"]);
    expect(p).not.toHaveProperty("skipped_non_finite");
  });

  it("skips and counts non-finite cash expenses Python stored (Q14) instead of crashing", () => {
    ds.dispose();
    ds = syntheticDataset(`${SEED}
INSERT INTO transactions VALUES
  (3, 2, '2026-08-03', NULL, 'NaN', 'PLN', NULL, NULL, 'X', NULL, 'MANUAL', 'h3', 0, NULL, 0, NULL, NULL, NULL),
  (4, 2, '2026-08-04', NULL, '-Infinity', 'PLN', NULL, NULL, 'X', NULL, 'MANUAL', 'h4', 0, NULL, 0, NULL,
   NULL, NULL);`);
    const p = run(produceNetworth).p as Tree;
    expect(p.totals).toEqual({ PLN: "9279.50", EUR: "10.00" });
    expect(p.skipped_non_finite).toBe(2);
  });
});

describe("core.networth_series producer", () => {
  it("evaluates the loan and the vehicle on the balance dates, per currency", () => {
    const { p } = run(produceNetworthSeries);
    const pln = (p as Tree).PLN as Tree;
    const daily = new Map(pln.daily_total as [string, string][]);
    // the loan's anchor date is a point: the recorded 4000 drives it from that day
    expect(daily.get("2026-06-01")).toBe("-4000.00");
    // 2026-09-01: checking 1100 + loan (4000 - 1500 repaid since) + cash 179.50 (from 08-02)
    expect(daily.get("2026-09-01")).toBe("-1220.50");
    const monthly = pln.monthly_components as [string, Tree][];
    expect(monthly.at(-1)).toEqual([
      "2026-09-01",
      { money: "1279.50", loan: "-2500.00", vehicle: "0.00" },
    ]);
    // the liquid series leaves the loan and the car out
    expect(new Map(pln.weekly_liquid as [string, string][]).get("2026-09-01")).toBe("1279.50");
    expect((p as Tree).EUR).toBeDefined();
  });
});

describe("loans.valuation producer", () => {
  it("summarizes each loan, its anchors and its valuation at the probe dates", () => {
    const { p, account, loan } = run(produceLoansValuation);
    const [row] = p as Tree[];
    expect(row?.loan_id).toBe(loan);
    expect(row?.anchors).toEqual([["2026-06-01", "4000.00"]]);
    expect(row?.latest).toEqual(["2026-10-01", "2000.00"]);
    const summary = row?.summary as Tree;
    expect(summary).toMatchObject({
      id: loan,
      account_id: account(3),
      name: "Kredyt Test",
      currency: "PLN",
      principal: 12000,
      outstanding: 2000,
      schedule_outstanding: 1000,
      balance_source: "recorded",
      months_elapsed: 22,
      payment_iban_tail: "1234",
      payment_text: null,
    });
    expect((summary.schedule as unknown[]).length).toBe(24);
    const raw = row?.summary_raw as Tree;
    expect([raw.principal, raw.monthly_payment, raw.outstanding]).toEqual([
      "12000",
      "500.00",
      "1000.00",
    ]);
    const at = new Map(((row?.valuation ?? []) as Tree[]).map((v) => [v.date, [v.at, v.source]]));
    expect(at.get("2024-12-01")).toEqual(["0", "schedule"]);
    expect(at.get("2026-05-31")).toEqual(["3500.00", "schedule"]);
    expect(at.get("2026-06-01")).toEqual(["4000.00", "recorded"]);
  });
});

describe("assets.depreciation producer", () => {
  it("lists the manual positions largest first and values each curve at the probe dates", () => {
    const { p, account } = run(produceAssetsDepreciation);
    const tree = p as Tree;
    const rows = tree.manual_rows as Tree[];
    // module accounts only (manual: / vehicle: keys), by absolute value
    expect(rows.map((r) => [r.name, r.balance, r.kind])).toEqual([
      ["Auto Test", 10000, "vehicle"],
      ["Kredyt Test", -2000, "manual"],
      ["Konto EUR Test", 10, "manual"],
      ["Pusta Gotówka", 0, "manual"],
    ]);
    expect(rows[0]).toMatchObject({
      id: account(6),
      bank_name: "Ręcznie",
      note: "Notatka test",
      depreciation: {
        purchase_price: 10000,
        purchase_date: "2026-10-01",
        annual_rate: 0.15,
        floor: null,
      },
    });
    const [curve] = tree.depreciation as Tree[];
    const values = new Map(((curve?.values ?? []) as Tree[]).map((v) => [v.date, v.value]));
    expect(values.get("2026-09-30")).toBe("0.00");
    expect(values.get("2026-10-01")).toBe("10000.0");
  });
});
