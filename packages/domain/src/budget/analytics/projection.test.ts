// The month projection (companion "this month" card) and its book-based inputs over the seeded
// household (June-September 2026, salary 9000 on the 10th). Synthetic data only.

import { describe, expect, it } from "vitest";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { cashflowCoverageStart, monthlyCashflow } from "./cashflow.js";
import { closedMonthNorm, type MonthNorm, NORM_MONTHS } from "./overview.js";
import {
  categoryNorm,
  type MonthProjectionInput,
  monthProjection,
  usualPayDay,
  usualToDate,
} from "./projection.js";
import { Household } from "./testing/household.js";
import { seedDemo } from "./testing/seedDemo.js";

const eq = (a: Decimal | null | undefined, b: string) => expect(a?.eq(D(b))).toBe(true);
const norm = (income: string, expense: string): MonthNorm => ({
  income: D(income),
  expense: D(expense),
  months: 6,
});

const input = (over: Partial<MonthProjectionInput>): MonthProjectionInput => ({
  today: "2026-11-12",
  currency: "PLN",
  incomeSoFar: ZERO,
  spentSoFar: ZERO,
  billsDue: ZERO,
  norm: null,
  normToDate: null,
  usualPayDay: null,
  ...over,
});

describe("monthProjection (prototype numbers)", () => {
  it("owner: keep 2,140, 440 under the usual", () => {
    const p = monthProjection(
      input({
        incomeSoFar: D("14800"),
        spentSoFar: D("5960"),
        billsDue: D("5240"),
        norm: norm("14800", "13100"),
        normToDate: D("6400"),
        usualPayDay: 10,
      }),
    );
    eq(p.keep, "2140");
    eq(p.vsUsual, "-440");
    eq(p.usualRest, "6700");
    eq(p.remainingSpend, "6700");
    eq(p.incomeStillExpected, "0");
    eq(p.expectedIncome, "14800");
    expect(p.monthEnd).toBe("2026-11-30");
    expect(p.daysLeft).toBe(18);
    expect(p.pace?.spentShare).toBeCloseTo(5960 / 13100, 10);
    expect(p.pace?.usualShare).toBeCloseTo(6400 / 13100, 10);
  });

  it("partner: keep 910, 210 under the usual", () => {
    const p = monthProjection(
      input({
        incomeSoFar: D("9600"),
        spentSoFar: D("3410"),
        billsDue: D("2797"),
        norm: norm("9600", "8900"),
        normToDate: D("3620"),
        usualPayDay: 10,
      }),
    );
    eq(p.keep, "910");
    eq(p.vsUsual, "-210");
    eq(p.remainingSpend, "5280");
  });

  it("before the usual pay day the salary still counts", () => {
    const p = monthProjection(
      input({
        today: "2026-11-05",
        norm: norm("14800", "13100"),
        normToDate: D("2000"),
        usualPayDay: 10,
      }),
    );
    eq(p.expectedIncome, "14800");
    eq(p.incomeStillExpected, "14800");
    // 14800 - 0 - (13100 - 2000)
    eq(p.keep, "3700");
  });

  it("only the part of the usual income not in yet; nothing on or after the pay day", () => {
    const before = input({
      today: "2026-11-05",
      incomeSoFar: D("15000"),
      norm: norm("14800", "13100"),
      normToDate: D("2000"),
      usualPayDay: 10,
    });
    eq(monthProjection(before).incomeStillExpected, "0");
    eq(monthProjection({ ...before, incomeSoFar: D("800") }).incomeStillExpected, "14000");
    eq(monthProjection({ ...before, today: "2026-11-10" }).incomeStillExpected, "0");
    eq(monthProjection({ ...before, usualPayDay: null }).incomeStillExpected, "0");
  });

  it("bills above the usual rest take over", () => {
    const p = monthProjection(
      input({
        incomeSoFar: D("10000"),
        spentSoFar: D("4000"),
        billsDue: D("5000"),
        norm: norm("10000", "8000"),
        normToDate: D("4000"),
      }),
    );
    eq(p.usualRest, "4000");
    eq(p.remainingSpend, "5000");
    eq(p.keep, "1000");
    eq(p.vsUsual, "0");
  });

  it("without a norm: only bills, no pace, no comparison, no salary projected", () => {
    const p = monthProjection(
      input({
        today: "2026-02-03",
        incomeSoFar: D("3000"),
        spentSoFar: D("1000"),
        billsDue: D("500"),
        usualPayDay: 10,
      }),
    );
    eq(p.keep, "1500");
    eq(p.usualRest, "0");
    eq(p.incomeStillExpected, "0");
    expect(p.pace).toBeNull();
    expect(p.vsUsual).toBeNull();
    expect(p.monthEnd).toBe("2026-02-28");
    expect(p.daysLeft).toBe(25);
  });

  it("the usual rest never goes negative; last day leaves 0 days", () => {
    const p = monthProjection(
      input({
        today: "2026-11-30",
        spentSoFar: D("9000"),
        norm: norm("0", "8000"),
        normToDate: D("8000"),
      }),
    );
    eq(p.usualRest, "0");
    expect(p.daysLeft).toBe(0);
    eq(p.vsUsual, "1000");
  });

  it("a norm without spending has no pace", () => {
    const p = monthProjection(input({ norm: norm("100", "0"), normToDate: ZERO }));
    expect(p.pace).toBeNull();
  });
});

describe("usualToDate / usualPayDay / categoryNorm over the seeded household", () => {
  const book = seedDemo().book();
  // PLN is covered from 06-11 (the savings account's first row): June is a partial month and never
  // counts, so the norm months of October are July to September.
  const pln = (today: string) =>
    closedMonthNorm(
      monthlyCashflow(book, "PLN"),
      today,
      NORM_MONTHS,
      cashflowCoverageStart(book, "PLN"),
    );

  it("usual spending through the 5th: sport 139 + rent 650 + mortgage 3000 each month", () => {
    expect(cashflowCoverageStart(book, "PLN")).toBe("2026-06-11");
    eq(usualToDate(book, "PLN", "2026-10-05"), "3789");
    eq(usualToDate(book, "PLN", "2026-10-05", 1), "3789");
  });

  it("through the month's end it is the norm's spending", () => {
    eq(usualToDate(book, "PLN", "2026-10-31"), pln("2026-10-31")?.expense.toString() ?? "x");
    // the 30th is November's last day: every norm month counts in full
    eq(usualToDate(book, "PLN", "2026-11-30"), pln("2026-11-30")?.expense.toString() ?? "x");
  });

  it("the norm months are the same as closedMonthNorm's (running month excluded)", () => {
    // in September only June-August count: the September rows through the 5th are not averaged in
    eq(usualToDate(book, "PLN", "2026-09-05"), "3789");
  });

  it("no complete month: null / empty", () => {
    expect(usualToDate(book, "PLN", "2026-06-20")).toBeNull();
    expect(usualPayDay(book, "PLN", "2026-06-20")).toBeNull();
    expect(categoryNorm(book, "PLN", "2026-06-20").size).toBe(0);
    expect(usualToDate(book, "USD", "2026-10-05")).toBeNull();
  });

  it("the usual pay day is the salary's day", () => {
    expect(usualPayDay(book, "PLN", "2026-10-05")).toBe(10);
    // a single whole month (July; June is partial) is not enough
    expect(usualPayDay(book, "PLN", "2026-08-05")).toBeNull();
    expect(usualPayDay(book, "PLN", "2026-09-05")).toBe(10);
  });

  it("each currency on its own: EUR has one top-up, Spotify on the 14th", () => {
    eq(usualToDate(book, "EUR", "2026-10-05"), "0");
    eq(usualToDate(book, "EUR", "2026-10-14"), "9.99");
    expect(usualPayDay(book, "EUR", "2026-10-05")).toBeNull();
    const eur = categoryNorm(book, "EUR", "2026-10-05");
    expect([...eur.values()].reduce((a, b) => a.add(b), ZERO).eq(D("9.99"))).toBe(true);
  });

  it("category norms add up to the norm's spending, largest first", () => {
    const cats = categoryNorm(book, "PLN", "2026-10-05");
    const total = [...cats.values()].reduce((a, b) => a.add(b), ZERO);
    // each category divided by 3 on its own: equal to the norm up to the last digit
    const gap = total.sub(pln("2026-10-05")?.expense ?? ZERO).copyAbs();
    expect(gap.lt(D("0.000001"))).toBe(true);
    const values = [...cats.values()];
    for (let i = 1; i < values.length; i++) {
      expect((values[i - 1] as Decimal).gte(values[i] as Decimal)).toBe(true);
    }
    // the one-off August 55 counts as 55 / 3 months (July to September)
    expect(cats.get("other")?.eq(D("55").div(D("3")))).toBe(true);
  });
});

/**
 * One account imported over Open Banking from 08-11: August is a partial month (the 08-10 salary is
 * before the window). Spending: rent 2,500 on the 11th, groceries on the 20th, and in September and
 * October a 31st-free tail: a utility bill on the 29th / 30th / 31st of the month where it exists.
 */
function importedFromMidAugust(): Household {
  const h = new Household("PLN");
  const main = h.account({ name: "Konto Test", iban: "99116000000000000000000201" });
  const employer = "99109000000000000000000203";
  h.ingest(main, [
    { date: "2026-08-11", amount: "-2500.00", ref: "CZYNSZ TEST" },
    { date: "2026-08-20", amount: "-100.00", ref: "SKLEP TEST" },
    { date: "2026-09-10", amount: "9000.00", ref: "WYNAGRODZENIE 09", iban: employer },
    { date: "2026-09-11", amount: "-2500.00", ref: "CZYNSZ TEST" },
    { date: "2026-09-20", amount: "-1500.00", ref: "SKLEP TEST" },
    { date: "2026-09-30", amount: "-300.00", ref: "PRAD TEST" },
    { date: "2026-10-12", amount: "9000.00", ref: "WYNAGRODZENIE 10", iban: employer },
    { date: "2026-10-11", amount: "-2500.00", ref: "CZYNSZ TEST" },
    { date: "2026-10-20", amount: "-1500.00", ref: "SKLEP TEST" },
    { date: "2026-10-31", amount: "-300.00", ref: "PRAD TEST" },
    { date: "2026-11-05", amount: "-400.00", ref: "SKLEP TEST" },
  ]);
  return h;
}

describe("the norm months skip an import's partial first month", () => {
  const book = importedFromMidAugust().book();

  it("August (from the 11th) is not a norm month: September and October are", () => {
    const rows = monthlyCashflow(book, "PLN");
    const start = cashflowCoverageStart(book, "PLN");
    expect(start).toBe("2026-08-11");
    const n = closedMonthNorm(rows, "2026-11-09", NORM_MONTHS, start);
    expect(n?.months).toBe(2);
    eq(n?.income, "9000");
    eq(n?.expense, "4300");
    // without the coverage start the partial August would drag both averages down
    expect(closedMonthNorm(rows, "2026-11-09")?.months).toBe(3);
  });

  it("usualToDate, usualPayDay and categoryNorm average the same two months", () => {
    // through the 15th: rent 2,500 in September and October
    eq(usualToDate(book, "PLN", "2026-11-15"), "2500");
    // pay days 10 and 12: the lower middle
    expect(usualPayDay(book, "PLN", "2026-11-15")).toBe(10);
    const total = [...categoryNorm(book, "PLN", "2026-11-15").values()].reduce(
      (a, b) => a.add(b),
      ZERO,
    );
    eq(total, "4300");
  });
});

describe("usualToDate on the last day of a short month", () => {
  const book = importedFromMidAugust().book();

  it("30 November: the 31 October bill is spent too, the usual rest is 0", () => {
    eq(usualToDate(book, "PLN", "2026-11-30"), "4300");
    // on the 29th the 30 September / 31 October bills are still ahead
    eq(usualToDate(book, "PLN", "2026-11-29"), "4000");
  });

  it("28 February: every norm month counts in full", () => {
    // norm months of February 2027: September, October and November (400); December and January
    // have no rows and are skipped. (4,300 + 4,300 + 400) / 3 = 3,000; through the 27th 2,800.
    const n = closedMonthNorm(
      monthlyCashflow(book, "PLN"),
      "2027-02-28",
      NORM_MONTHS,
      cashflowCoverageStart(book, "PLN"),
    );
    eq(n?.expense, "3000");
    eq(usualToDate(book, "PLN", "2027-02-28"), "3000");
    eq(usualToDate(book, "PLN", "2027-02-27"), "2800");
    const p = monthProjection(
      input({
        today: "2027-02-28",
        norm: n,
        normToDate: usualToDate(book, "PLN", "2027-02-28"),
      }),
    );
    eq(p.usualRest, "0");
    expect(p.daysLeft).toBe(0);
    expect(p.pace?.usualShare).toBe(1);
  });
});
