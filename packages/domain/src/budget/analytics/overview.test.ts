// The spending norm of complete months: frontend/tests/loans.test.mjs "FE10: ratios divide by the average
// of complete months, never the running one", test-for-test (the incomeShare half stays in ui-logic).
// The month / subscriptions halves of the summary are tested on the seeded household (src/overview.test.ts).

import { describe, expect, it } from "vitest";
import { D } from "../../decimal.js";
import type { MonthlyCashflow } from "./cashflow.js";
import { closedMonthNorm, monthSummary, subscriptionsSummary } from "./overview.js";

const row = (label: string, income: string, expense: string): MonthlyCashflow => ({
  year: Number(label.slice(0, 4)),
  month: Number(label.slice(5, 7)),
  label,
  income: D(income),
  expense: D(expense),
  net: D(income).sub(D(expense)),
});

describe("closedMonthNorm (FE10)", () => {
  const rows = [
    row("2026-07", "9000", "8000"),
    row("2026-08", "9000", "8800"),
    row("2026-09", "9300", "9000"),
    row("2026-10", "0", "1250"),
  ];

  it("ratios divide by the average of complete months, never the running one", () => {
    const n = closedMonthNorm(rows, "2026-10-05");
    expect(n?.months).toBe(3);
    expect(n?.income.eq(D("9100"))).toBe(true);
    expect(n?.expense.eq(D("8600"))).toBe(true);
    expect(closedMonthNorm([row("2026-10", "100", "50")], "2026-10-05")).toBeNull();
    expect(closedMonthNorm(null, "2026-10-05")).toBeNull();
    expect(closedMonthNorm(rows, "2026-10-05", 1)?.expense.eq(D("9000"))).toBe(true);
    // liquid 52 000 / 8 600 = 6,0 months (not 41,6 with October's 1 250)
    const months = D("52000").div(n?.expense ?? D("1"));
    expect(months.quantize(D("0.1")).toString()).toBe("6.0");
  });

  it("months without income or spending are skipped", () => {
    const n = closedMonthNorm([row("2026-08", "0", "0"), row("2026-09", "10", "4")], "2026-10-05");
    expect(n?.months).toBe(1);
  });
});

describe("summary halves", () => {
  it("the month is the newest row, none without rows", () => {
    expect(monthSummary([])).toBeNull();
    expect(monthSummary([row("2026-08", "1", "2"), row("2026-09", "3", "1")])?.label).toBe(
      "2026-09",
    );
  });

  it("subscriptions: per currency, PLN alone in the legacy total", () => {
    const sub = (currency: string, amount: string) => ({
      counterparty: `X ${currency} ${amount}`,
      typicalAmount: D(amount),
      occurrences: 3,
      monthsCovered: 3,
      medianGapDays: 30,
      lastDate: "2026-09-01",
      currency,
    });
    const out = subscriptionsSummary([
      sub("PLN", "43.00"),
      sub("EUR", "9.99"),
      sub("PLN", "139.00"),
    ]);
    expect(out.count).toBe(3);
    expect(out.monthlyTotal.toString()).toBe("182.00");
    expect(Object.keys(out.monthlyTotals)).toEqual(["EUR", "PLN"]);
    expect(subscriptionsSummary([sub("EUR", "1.00")]).monthlyTotal.toString()).toBe("0");
  });
});
