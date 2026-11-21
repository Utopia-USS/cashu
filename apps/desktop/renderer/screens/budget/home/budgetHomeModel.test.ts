import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import {
  averageSpending,
  averageSurplusBefore,
  chartWindow,
  clampMonth,
  dataRange,
  daysBetween,
  defaultMonth,
  type FlowMonth,
  groupBounds,
  isMonthly,
  monthIndex,
  monthKey,
  nextCharge,
  niceTicks,
  periodGroups,
  periodSurplus,
  periodTotals,
  queryPeriod,
  savingsRate,
} from "./budgetHomeModel.js";

/** Synthetic months: [label, income, expense]. */
const flow = (rows: [string, string, string][]): FlowMonth[] =>
  rows.map(([label, income, expense]) => ({
    i: monthIndex(label),
    income: D(income),
    expense: D(expense),
  }));

describe("month indices", () => {
  it("round-trips a month", () => {
    expect(monthKey(monthIndex("2026-10"))).toBe("2026-10");
    expect(monthKey(monthIndex("2026-01") - 1)).toBe("2025-12");
    expect(Number.isNaN(monthIndex("nope"))).toBe(true);
  });

  it("bounds a month's quarter and year", () => {
    const oct = monthIndex("2026-10");
    expect(groupBounds("quarter", oct).map(monthKey)).toEqual(["2026-10", "2026-12"]);
    expect(groupBounds("year", oct).map(monthKey)).toEqual(["2026-01", "2026-12"]);
    expect(groupBounds("month", oct).map(monthKey)).toEqual(["2026-10", "2026-10"]);
  });

  it("gives the store's period args", () => {
    const aug = monthIndex("2026-08");
    expect(queryPeriod("month", aug)).toEqual({ year: 2026, month: 8 });
    expect(queryPeriod("quarter", aug)).toEqual({ year: 2026, quarter: 3 });
    expect(queryPeriod("year", aug)).toEqual({ year: 2026 });
    expect(queryPeriod("all", aug)).toEqual({});
  });
});

describe("defaultMonth (the month close's rule)", () => {
  it("is the month before today's when the data reaches today's month", () => {
    expect(monthKey(defaultMonth("2026-11-07", "2026-11-09"))).toBe("2026-10");
    expect(monthKey(defaultMonth(null, "2026-11-09"))).toBe("2026-10");
  });

  it("is the newest booking's month when the data stops earlier", () => {
    expect(monthKey(defaultMonth("2026-06-30", "2026-11-09"))).toBe("2026-06");
  });
});

describe("periodGroups / periodTotals", () => {
  const rows = flow([
    ["2026-01", "100.00", "40.00"],
    ["2026-02", "100.00", "60.00"],
    // March has no transactions: a zero month, still counted.
    ["2026-04", "200.00", "50.00"],
    ["2026-05", "10.00", "5.00"],
  ]);
  const today = monthIndex("2026-05");

  it("fills gaps and marks the month in progress", () => {
    const months = periodGroups(rows, "month", today);
    expect(months.map((g) => monthKey(g.first))).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    expect(months[2]?.income.toString()).toBe("0.00");
    expect(months.map((g) => g.partial)).toEqual([false, false, false, false, true]);
  });

  it("sums quarters and years", () => {
    const quarters = periodGroups(rows, "quarter", today);
    expect(quarters).toHaveLength(2);
    expect(quarters[0]?.income.toString()).toBe("200.00");
    expect(quarters[0]?.months).toBe(3);
    expect(quarters[1]?.months).toBe(2);
    expect(quarters[1]?.partial).toBe(true);
    const years = periodGroups(rows, "year", today);
    expect(years).toHaveLength(1);
    expect(years[0]?.expense.toString()).toBe("155.00");
  });

  it("totals the selected group, or everything for all", () => {
    const quarters = periodGroups(rows, "quarter", today);
    const q1 = periodTotals(quarters, "quarter", monthIndex("2026-02"));
    expect(q1.income.toString()).toBe("200.00");
    expect(q1.partial).toBe(false);
    const years = periodGroups(rows, "year", today);
    const all = periodTotals(years, "all", monthIndex("2026-02"));
    expect(all.income.toString()).toBe("410.00");
    expect(all.months).toBe(5);
  });

  it("averages a period over its complete months only", () => {
    const quarters = periodGroups(rows, "quarter", today);
    // Q2: April complete (+150), May in progress (left out of the average).
    const q2 = periodTotals(quarters, "quarter", monthIndex("2026-05"));
    expect(q2.months).toBe(2);
    expect(q2.doneMonths).toBe(1);
    expect(q2.doneAverage?.toFloat()).toBe(150);
    // All: January to April complete (60 + 40 + 0 + 150) / 4.
    const all = periodTotals(periodGroups(rows, "year", today), "all", today);
    expect(all.doneMonths).toBe(4);
    expect(all.doneAverage?.toFloat()).toBe(62.5);
  });

  it("has no average without a complete month", () => {
    const may = periodTotals(periodGroups(rows, "month", today), "month", today);
    expect(may.doneMonths).toBe(0);
    expect(may.doneAverage).toBeNull();
  });

  it("gives another currency's surplus over the same period", () => {
    expect(periodSurplus(rows, "quarter", monthIndex("2026-02"), today).toString()).toBe("100.00");
    expect(periodSurplus(rows, "all", today, today).toString()).toBe("255.00");
  });

  it("has nothing without data", () => {
    expect(periodGroups([], "month", today)).toEqual([]);
    expect(periodTotals([], "month", today).income.toString()).toBe("0.00");
  });
});

describe("clampMonth (the shown currency's data range)", () => {
  // EUR data from March to June 2026 only.
  const eur = flow([
    ["2026-03", "0.00", "40.00"],
    ["2026-06", "0.00", "60.00"],
  ]);
  const range = dataRange(eur);

  it("keeps a month inside the data", () => {
    expect(range && monthKey(range.first)).toBe("2026-03");
    expect(range && monthKey(range.last)).toBe("2026-06");
    expect(monthKey(clampMonth(monthIndex("2026-04"), range))).toBe("2026-04");
  });

  it("opens a currency whose data ends earlier on its last month, not an empty one", () => {
    const profileDefault = defaultMonth("2026-11-07", "2026-11-09");
    expect(monthKey(clampMonth(profileDefault, range))).toBe("2026-06");
  });

  it("moves a month before the data to its first month", () => {
    expect(monthKey(clampMonth(monthIndex("2025-12"), range))).toBe("2026-03");
  });

  it("leaves the month as asked without data", () => {
    expect(dataRange([])).toBeNull();
    expect(monthKey(clampMonth(monthIndex("2026-10"), null))).toBe("2026-10");
  });
});

describe("chartWindow", () => {
  it("shows everything when it fits", () => {
    expect(chartWindow(5, 2)).toEqual([0, 5]);
  });

  it("keeps the selection in view, one group right of it when there is one", () => {
    expect(chartWindow(30, 20)).toEqual([9, 22]);
    expect(chartWindow(30, 28)).toEqual([17, 30]);
    expect(chartWindow(30, 29)).toEqual([17, 30]);
    expect(chartWindow(30, 3)).toEqual([0, 13]);
  });

  it("shows the last groups without a selection", () => {
    expect(chartWindow(30, null)).toEqual([17, 30]);
  });
});

describe("niceTicks", () => {
  it("rounds to 2-4 intervals of a round step", () => {
    const t = niceTicks(23_400);
    expect(t.step).toBe(10_000);
    expect(t.top).toBe(30_000);
    expect(t.values).toEqual([0, 10_000, 20_000, 30_000]);
    const small = niceTicks(380);
    expect(small.values.length - 1).toBeGreaterThanOrEqual(2);
    expect(small.values.length - 1).toBeLessThanOrEqual(4);
    expect(small.top).toBeGreaterThanOrEqual(380);
  });

  it("has a unit axis for zero", () => {
    expect(niceTicks(0)).toEqual({ step: 1, top: 1, values: [0, 1] });
  });
});

describe("averages", () => {
  const rows = flow([
    ["2026-06", "1000.00", "400.00"],
    ["2026-07", "1000.00", "600.00"],
    ["2026-08", "1000.00", "500.00"],
    ["2026-09", "1000.00", "700.00"],
    ["2026-10", "1000.00", "900.00"],
    ["2026-11", "100.00", "50.00"],
  ]);
  const today = monthIndex("2026-11");

  it("averages the complete months before a month", () => {
    const avg = averageSurplusBefore(rows, monthIndex("2026-10"), today);
    expect(avg?.months).toBe(4);
    expect(avg?.average.toFloat()).toBe(450);
  });

  it("needs three months", () => {
    expect(averageSurplusBefore(rows, monthIndex("2026-08"), today)).toBeNull();
  });

  it("averages the complete months' spending before today's", () => {
    expect(averageSpending(rows, today)?.toFloat()).toBe(620);
    expect(averageSpending([], today)).toBeNull();
  });

  it("rates the savings", () => {
    expect(savingsRate(16_900, 10_862.4)).toBe(36);
    expect(savingsRate(0, 100)).toBe(0);
    expect(savingsRate(100, 150)).toBe(-50);
  });
});

describe("subscriptions", () => {
  it("expects the next charge one median gap after the last", () => {
    expect(nextCharge("2026-10-14", 31)).toBe("2026-11-14");
    expect(nextCharge("2026-12-20", 30)).toBe("2027-01-19");
    expect(daysBetween("2026-11-09", "2026-11-14")).toBe(5);
    expect(daysBetween("2026-11-09", "2026-11-01")).toBe(-8);
  });

  it("reads 28 to 32 days as monthly", () => {
    expect(isMonthly(31)).toBe(true);
    expect(isMonthly(28)).toBe(true);
    expect(isMonthly(14)).toBe(false);
    expect(isMonthly(33)).toBe(false);
  });
});
