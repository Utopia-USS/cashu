import { describe, expect, it } from "vitest";
import { addMonths, utcIso } from "./dates.js";
import {
  D,
  Decimal,
  DecimalError,
  decimalKey,
  format2,
  getContext,
  localContext,
  sum,
} from "./decimal.js";
import { ibanKey } from "./iban.js";
import { CurrencyError, EXACT_CONTEXT, exactDecimals, Money, toCurrency } from "./money.js";
import { normalizeText } from "./text.js";

describe("gid.md section 3 canonical text", () => {
  it("decimal_key: plain, exact, trailing zeros and -0 removed", () => {
    expect(decimalKey(D("10.50"))).toBe("10.5");
    expect(decimalKey(D("1E+1"))).toBe("10");
    expect(decimalKey(D("-0.000"))).toBe("0");
    expect(decimalKey(D("0.000000000000000000001"))).toBe("0.000000000000000000001");
    expect(decimalKey(null)).toBe("");
  });

  it('format(d, ".2f"): half-even, sign kept on a zero result', () => {
    expect(format2(D("-0.001"))).toBe("-0.00");
    expect(format2(D("2.675"))).toBe("2.68");
    expect(format2(D("0.125"))).toBe("0.12");
    expect(format2(D("1E+3"))).toBe("1000.00");
  });
});

describe("Decimal keeps Python's exponent", () => {
  it("str() and arithmetic", () => {
    expect(D("1.50").add(D("2")).toString()).toBe("3.50");
    expect(sum([D("1E+1")]).toString()).toBe("10");
    expect(D("1").div(D("3")).toString()).toBe("0.3333333333333333333333333333");
    expect(D("-0").toString()).toBe("-0");
    expect(D("0.0000001").toString()).toBe("1E-7");
    expect(Decimal.fromFloat(0.1).toString()).toBe(
      "0.1000000000000000055511151231257827021181583404541015625",
    );
  });

  it("localContext and exactDecimals scope the context", () => {
    expect(getContext().prec).toBe(28);
    exactDecimals(() => expect(getContext()).toBe(EXACT_CONTEXT));
    localContext({ ...getContext(), prec: 3 }, () =>
      expect(D("1").div(D("3")).toString()).toBe("0.333"),
    );
    expect(getContext().prec).toBe(28);
  });

  it("traps like Python's default context", () => {
    expect(() => D("1").div(D("0"))).toThrow(DecimalError);
    expect(() => D("NaN")).toThrow(/NonFinite/);
    expect(() => D("1,5")).toThrow(/InvalidOperation/);
  });
});

describe("Money", () => {
  it("adds within one currency and refuses to mix", () => {
    const a = new Money(D("10.50"), "pln");
    expect(a.add(new Money(D("2"), toCurrency("PLN"))).toString()).toBe("12.50 PLN");
    expect(() => a.add(new Money(D("1"), "EUR"))).toThrow(CurrencyError);
    expect(Money.zero("usd").toString()).toBe("0 USD");
  });
});

describe("text, IBAN, dates", () => {
  it("examples", () => {
    expect(normalizeText("  Zażółć \t gęślą  JAŹŃ ")).toBe("ZAZOLC GESLA JAZN");
    expect(ibanKey("PL61 1090 1014 0000 0712 1981 2874")).toBe(
      ibanKey("'61109010140000071219812874"),
    );
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(utcIso("2026-01-01 10:00:00.000000")).toBe("2026-01-01T10:00:00+00:00");
    expect(utcIso("2026-01-01T01:30:00+02:00")).toBe("2025-12-31T23:30:00+00:00");
  });
});
