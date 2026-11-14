// Amortization math (`modules/loans/amortization.py`). No pytest file targets it directly (test_loans.py
// uses it as its oracle); these pin the formulas on hand-checked values, the edges of `outstanding`
// and `summarize`.

import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { monthlyPayment, outstanding, schedule, summarize } from "./amortization.js";

const str = (d: { toString(): string }) => d.toString();

describe("monthlyPayment", () => {
  it("is the annuity installment quantized half-up to cents", () => {
    expect(str(monthlyPayment(D("60000"), D("8.9"), 60))).toBe("1242.59");
    expect(str(monthlyPayment(D("420000"), D("6.2"), 300))).toBe("2757.64");
  });

  it("splits the principal evenly at a zero rate", () => {
    expect(str(monthlyPayment(D("1000"), D("0"), 3))).toBe("333.33");
    expect(str(monthlyPayment(D("1000"), D("0.0"), 6))).toBe("166.67");
  });
});

describe("schedule", () => {
  it("starts on the start date, steps by calendar months and clamps the day", () => {
    const rows = schedule(D("1200"), D("12"), 4, "2024-01-31");
    expect(rows.map((r) => r.date)).toEqual([
      "2024-01-31",
      "2024-02-29",
      "2024-03-31",
      "2024-04-30",
    ]);
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4]);
  });

  it("first row: interest on the full principal, the rest of the installment repays", () => {
    const [first] = schedule(D("60000"), D("8.9"), 60, "2024-11-10");
    expect(
      first && [first.payment, first.interest, first.principal, first.balance].map(str),
    ).toEqual(["1242.59", "445.00", "797.59", "59202.41"]);
  });

  it("the last installment settles the remaining balance to exactly zero", () => {
    const rows = schedule(D("1000"), D("0"), 3, "2025-01-01");
    expect(rows.map((r) => [str(r.payment), str(r.principal), str(r.balance)])).toEqual([
      ["333.33", "333.33", "666.67"],
      ["333.33", "333.33", "333.34"],
      ["333.34", "333.34", "0.00"],
    ]);
  });
});

describe("outstanding", () => {
  const rows = schedule(D("1000"), D("0"), 3, "2025-01-01");

  it("is 0 without rows and before origination", () => {
    expect(str(outstanding([], "2025-06-01"))).toBe("0");
    expect(str(outstanding(rows, "2024-12-31"))).toBe("0");
    expect(str(outstanding(rows, "2024-12-09", "2024-12-10"))).toBe("0");
  });

  it("is the full principal between origination and the first installment", () => {
    expect(str(outstanding(rows, "2024-12-10", "2024-12-10"))).toBe("1000.00");
    expect(str(outstanding(rows, "2024-12-31", "2024-12-10"))).toBe("1000.00");
  });

  it("follows the installments dated on or before the date", () => {
    expect(str(outstanding(rows, "2025-01-01"))).toBe("666.67");
    expect(str(outstanding(rows, "2025-01-31"))).toBe("666.67");
    expect(str(outstanding(rows, "2025-02-28"))).toBe("333.34");
    expect(str(outstanding(rows, "2025-03-01"))).toBe("0.00");
    expect(str(outstanding(rows, "2030-01-01"))).toBe("0.00");
  });
});

describe("summarize", () => {
  it("counts the elapsed installments and the interest paid / left", () => {
    const s = summarize(D("60000"), D("8.9"), 60, "2024-11-10", "2026-10-01");
    expect(s.monthsElapsed).toBe(23);
    expect(
      [s.monthlyPayment, s.outstanding, s.paidPrincipal, s.paidInterest, s.totalInterest].map(str),
    ).toEqual(["1242.59", "40078.14", "19921.86", "8657.71", "14555.49"]);
    expect(str(s.remainingInterest)).toBe("5897.78");
    expect(s.payoffDate).toBe("2029-10-10");
    expect(s.schedule).toHaveLength(60);
  });

  it("before the first installment nothing is paid", () => {
    const s = summarize(D("1000"), D("0"), 3, "2025-01-01", "2024-06-01");
    expect([s.monthsElapsed, str(s.paidInterest), str(s.paidPrincipal)]).toEqual([
      0,
      "0.00",
      "1000.00",
    ]);
  });
});
