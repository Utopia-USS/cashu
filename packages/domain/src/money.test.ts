import { describe, expect, it } from "vitest";
import { D, DecimalError } from "./decimal.js";
import { CurrencyError, dividedBy, ratio, toCurrency } from "./money.js";

describe("money helpers", () => {
  it("dividedBy quantizes half-up to the scale and refuses division by zero", () => {
    expect(dividedBy(D("5.14"), D("3.28"), 4).toString()).toBe("1.5671");
    expect(dividedBy(D("380.27"), D("-50.995"), 2).toString()).toBe("-7.46");
    expect(dividedBy(D("1"), D("8"), 2).toString()).toBe("0.13");
    expect(dividedBy(D("0.000065"), D("-0.000065")).toString()).toBe("-1.0000000000");
    expect(() => dividedBy(D("-69396254723"), D("0.00"), 6)).toThrow(DecimalError);
  });

  it("ratio is a float share, null for a missing part or a zero total", () => {
    expect(ratio(D("-1047.57"), D("-934.86"))).toBe(1.120563506835248);
    expect(ratio(D("1"), D("4"))).toBe(0.25);
    expect(ratio(null, D("10"))).toBeNull();
    expect(ratio(D("5"), D("0.00"))).toBeNull();
  });

  it("toCurrency trims, upper-cases and refuses anything but three letters", () => {
    expect(toCurrency(" usd ")).toBe("USD");
    expect(toCurrency("\tchf\n")).toBe("CHF");
    for (const bad of ["US", "", "123", "PLNX"])
      expect(() => toCurrency(bad), bad).toThrow(CurrencyError);
  });
});
