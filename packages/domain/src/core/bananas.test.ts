import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import {
  bananaScale,
  portfolioAnchor,
  type SalaryMonth,
  salaryAnchor,
  toBananas,
} from "./bananas.js";

const month = (m: string, salary: string, hasData = true): SalaryMonth => ({
  month: m,
  salary: D(salary),
  hasData,
});

describe("banana anchor", () => {
  it("averages the salary over the complete months with data, the running month left out", () => {
    const months = [
      month("2026-08", "10000"),
      month("2026-09", "10000"),
      month("2026-10", "13000"),
      month("2026-11", "50000"),
    ];
    expect(salaryAnchor(months, "2026-11-09")?.toString()).toBe("11000");
  });

  it("spreads an irregular payout over every month of the window", () => {
    const months = [month("2026-07", "0"), month("2026-08", "0"), month("2026-09", "30000")];
    expect(salaryAnchor(months, "2026-11-09")?.toString()).toBe("10000");
  });

  it("looks back 12 months at most and skips months without budget data", () => {
    const months = [
      month("2025-01", "999999"),
      ...Array.from({ length: 12 }, (_, i) =>
        month(`2025-${String(i + 2).padStart(2, "0")}`, "6000"),
      ),
      month("2026-02", "1", false),
    ];
    expect(salaryAnchor(months, "2026-11-09")?.toString()).toBe("6000");
  });

  it("has no salary anchor without a salary", () => {
    expect(salaryAnchor([], "2026-11-09")).toBeNull();
    expect(salaryAnchor([month("2026-10", "0")], "2026-11-09")).toBeNull();
  });

  it("takes a tenth of a positive portfolio", () => {
    expect(portfolioAnchor(D("250000"))?.toString()).toBe("25000.0");
    expect(portfolioAnchor(D("0"))).toBeNull();
    expect(portfolioAnchor(null)).toBeNull();
  });
});

describe("banana scale", () => {
  it("puts the anchor at exactly 1000 and converts other currencies through PLN", () => {
    const scale = bananaScale("salary", D("8000"), { EUR: 4.25 });
    expect(scale).not.toBeNull();
    if (scale === null) return;
    expect(toBananas(scale, 8000, "PLN")).toBe(1000);
    expect(toBananas(scale, D("-2000"), "PLN")).toBe(-250);
    expect(toBananas(scale, 100, "EUR")).toBeCloseTo(53.125, 9);
  });

  it("gives no banana value for a currency without a rate", () => {
    const scale = bananaScale("portfolio", D("1000"), {});
    expect(scale && toBananas(scale, 5, "USD")).toBeNull();
  });

  it("has no scale without a positive anchor", () => {
    expect(bananaScale("salary", null, {})).toBeNull();
    expect(bananaScale("salary", D("0"), {})).toBeNull();
  });
});
