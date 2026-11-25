// The savings rate after a first Open Banking import: the import reaches ~90 days back, so its first
// month starts mid-month (after that month's salary) and reads as a month of spending without income.
// Only whole months count; internal transfers (own counterparty IBAN) are neither side. Synthetic data.

import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import {
  averageSavingsRate,
  cashflowCoverageStart,
  type MonthlyCashflow,
  monthlyCashflow,
  wholeMonths,
} from "./cashflow.js";
import { closedMonthNorm } from "./overview.js";
import { Household, type Raw } from "./testing/household.js";

const IBAN_MAIN = "99116000000000000000000101";
const IBAN_SAVINGS = "99116000000000000000000102";
const IBAN_EMPLOYER = "99109000000000000000000103";

/** Two accounts connected on 11-09; the bank sent rows from 08-11 (main) and 08-14 (savings). */
function importedHousehold(): Household {
  const h = new Household("PLN");
  const main = h.account({ name: "Konto Test", iban: IBAN_MAIN });
  const savings = h.account({ name: "Oszczędności Test", iban: IBAN_SAVINGS, type: "savings" });
  const rows: Raw[] = [
    // August from the 11th: the salary of 08-10 is before the window.
    { date: "2026-08-11", amount: "-2500.00", ref: "CZYNSZ TEST" },
    { date: "2026-08-20", amount: "-900.00", ref: "SKLEP TEST" },
    { date: "2026-08-31", amount: "0.40", ref: "ODSETKI TEST" },
  ];
  for (const m of ["09", "10"]) {
    rows.push(
      { date: `2026-${m}-10`, amount: "9000.00", ref: `WYNAGRODZENIE ${m}`, iban: IBAN_EMPLOYER },
      { date: `2026-${m}-11`, amount: "-2500.00", ref: "CZYNSZ TEST" },
      { date: `2026-${m}-20`, amount: "-1500.00", ref: "SKLEP TEST" },
      // Moved to the own savings account: an internal transfer by IBAN, no spending.
      { date: `2026-${m}-12`, amount: "-3000.00", ref: "PRZELEW WŁASNY", iban: IBAN_SAVINGS },
    );
  }
  rows.push({ date: "2026-11-05", amount: "-400.00", ref: "SKLEP TEST" });
  h.ingest(main, rows);
  h.ingest(savings, [
    { date: "2026-08-14", amount: "1.00", ref: "ODSETKI TEST" },
    { date: "2026-09-12", amount: "3000.00", ref: "PRZELEW WŁASNY", iban: IBAN_MAIN },
    { date: "2026-10-12", amount: "3000.00", ref: "PRZELEW WŁASNY", iban: IBAN_MAIN },
  ]);
  return h;
}

const brief = (rows: readonly MonthlyCashflow[]) =>
  rows.map((r) => [r.label, r.income.toString(), r.expense.toString()]);

describe("whole months of the cashflow", () => {
  const book = importedHousehold().book();
  const rows = monthlyCashflow(book);
  const start = cashflowCoverageStart(book);

  it("own transfers are neither income nor spending; August is the import's partial month", () => {
    expect(brief(rows)).toEqual([
      ["2026-08", "1.40", "3400.00"],
      ["2026-09", "9000.00", "4000.00"],
      ["2026-10", "9000.00", "4000.00"],
      ["2026-11", "0.00", "400.00"],
    ]);
  });

  it("every account has rows from the latest first day among them", () => {
    expect(start).toBe("2026-08-14");
    expect(wholeMonths(rows, start).map((r) => r.label)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(wholeMonths(rows, null)).toHaveLength(4);
  });

  it("the 6-month savings rate reads whole closed months, summed: no August at -242 757 %", () => {
    // The old mean of monthly ratios with August: (-3398.6 / 1.4 + 5/9 + 5/9) / 3, about -80 880 %.
    const rate = averageSavingsRate(rows, start, "2026-11-09");
    expect(rate?.toString()).toBe(D("10000.00").div(D("18000.00")).toString());
    expect(averageSavingsRate(rows, start, "2026-10-09")).toBeNull(); // one whole closed month
  });

  it("the spending norm skips the partial month too", () => {
    const norm = closedMonthNorm(wholeMonths(rows, start), "2026-11-09");
    expect(norm && [norm.months, norm.expense.toString()]).toEqual([2, "4000.00"]);
  });

  it("no transactions, no coverage start", () => {
    expect(cashflowCoverageStart(new Household("PLN").book())).toBeNull();
  });
});
