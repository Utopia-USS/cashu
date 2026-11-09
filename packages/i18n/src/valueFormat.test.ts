import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { formatBananaValue, formatCalendarDate, formatDecimalValue } from "./valueFormat.js";

describe("exact value formatting", () => {
  it.each(["pl-PL", "en-US", "en-GB", "ar-EG", "en-IN", "en-US-u-nu-arab", "en-US-u-nu-fullwide"])(
    "matches Intl punctuation and rounding for ordinary currency values in %s",
    (locale) => {
      for (const currency of ["PLN", "USD", "EUR", "JPY", "KWD"]) {
        const expected = new Intl.NumberFormat(locale, { style: "currency", currency });
        for (const value of [0, 1, -1, 0.125, -0.125, 1000, 1234567.125]) {
          expect(formatDecimalValue(D(String(value)), locale, { currency }).text).toBe(
            expected.format(value),
          );
        }
      }
    },
  );
  it("keeps digits beyond Number's safe range and rounds carries exactly", () => {
    expect(formatDecimalValue(D("9007199254740993.125"), "en-US", { currency: "USD" }).text).toBe(
      "$9,007,199,254,740,993.13",
    );
    expect(formatDecimalValue(D("999999999999999999.999"), "en-US").text).toBe(
      "1,000,000,000,000,000,000.00",
    );
    expect(formatDecimalValue(D("1E+30"), "en-US", { fractionDigits: 0 }).text).toBe(
      "1,000,000,000,000,000,000,000,000,000,000",
    );
  });
  it("treats percentages as ratios and uses exact rounding", () => {
    expect(formatDecimalValue(D("0.125"), "en-US", { percent: true }).text).toBe("12.5%");
    expect(formatDecimalValue(D("-0.0005"), "en-US", { percent: true }).text).toBe("-0.1%");
    expect(formatDecimalValue(D("0.125"), "pl-PL", { percent: true }).text).toBe("12,5%");
  });
  it("normalizes signed rounded zero, but signs nonzero changes", () => {
    expect(formatDecimalValue(D("-0.001"), "en-US", { signed: true })).toEqual({
      text: "0.00",
      sign: 0,
    });
    expect(formatDecimalValue(D("-0"), "en-US")).toEqual({ text: "-0.00", sign: 0 });
    expect(formatDecimalValue(D("1.234"), "en-US", { signed: true })).toEqual({
      text: "+1.23",
      sign: 1,
    });
  });
  it("keys formatter caches by locale, currency and precision", () => {
    expect(formatDecimalValue(D("1234.5"), "en-US").text).toBe("1,234.50");
    expect(formatDecimalValue(D("1234.5"), "pl-PL").text).toBe("1234,50");
    expect(formatDecimalValue(D("1234.5"), "en-US", { fractionDigits: 0 }).text).toBe("1,235");
  });
  it.each([-1, 1.5, 21, Number.NaN])("rejects invalid precision %s", (fractionDigits) => {
    expect(() => formatDecimalValue(D("1"), "en-US", { fractionDigits })).toThrow(RangeError);
  });
});

describe("calendar dates", () => {
  it("preserves the ISO date, including years below 100", () => {
    expect(formatCalendarDate("2026-10-01", "en-US")).toBe("Oct 1, 2026");
    expect(formatCalendarDate("0001-01-01", "en-US", "long")).toBe("January 1, 1");
    expect(formatCalendarDate("2000-02-29", "pl-PL", "short")).toBe("29.02.2000");
  });
  it("rejects impossible dates instead of normalizing them into the next month", () => {
    expect(() => formatCalendarDate("2026-02-29", "en-US")).toThrow();
  });
});

describe("banana values", () => {
  it("shrinks the digits with the size and keeps the sign", () => {
    expect(formatBananaValue(1000, "en-US").text).toBe("🍌 1,000");
    expect(formatBananaValue(-280.4, "en-US")).toEqual({ text: "-🍌 280", sign: -1 });
    expect(formatBananaValue(12.34, "en-US").text).toBe("🍌 12.3");
    expect(formatBananaValue(1.5, "pl-PL").text).toBe("🍌 1,5");
    expect(formatBananaValue(0.031, "en-US", { signed: true }).text).toBe("+🍌 0.03");
  });

  it("drops the sign of a rounded zero", () => {
    expect(formatBananaValue(-0.001, "en-US", { signed: true })).toEqual({ text: "🍌 0", sign: 0 });
  });
});
