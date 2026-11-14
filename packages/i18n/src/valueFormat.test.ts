import { D } from "@cashu/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appClockLocale,
  fillNumberTemplate,
  formatBananaValue,
  formatCalendarDate,
  formatCalendarDay,
  formatClockTime,
  formatDecimalValue,
  setNumberPartsForTests,
} from "./valueFormat.js";

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
  it("splits a list date into the day and the short weekday of its ISO day", () => {
    expect(formatCalendarDay("2026-11-12", "en-US")).toEqual({ day: "12", weekday: "Thu" });
    expect(formatCalendarDay("2026-11-12", "pl-PL")).toEqual({ day: "12", weekday: "czw." });
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

describe("formatClockTime", () => {
  const at = new Date(Date.UTC(2026, 10, 9, 7, 30));
  it("formats the time, optionally after the short weekday", () => {
    expect(formatClockTime(at, "pl-PL", { timeZone: "UTC" })).toBe("07:30");
    expect(formatClockTime(at, "pl-PL", { weekday: true, timeZone: "UTC" })).toBe("pon. 07:30");
    expect(formatClockTime(at, "en-GB", { timeZone: "UTC" })).toBe("07:30");
    expect(formatClockTime(at, "en-US", { weekday: true, timeZone: "UTC" })).toBe("Mon 07:30 AM");
  });

  it("writes a 12-hour locale's hour without the leading zero when asked, 24-hour ones as before", () => {
    const evening = new Date(Date.UTC(2026, 10, 15, 18, 0));
    const morning = new Date(Date.UTC(2026, 10, 15, 6, 5));
    const natural = { naturalHour: true, timeZone: "UTC" } as const;
    expect(formatClockTime(evening, "en-US", natural)).toBe("6:00 PM");
    expect(formatClockTime(morning, "en-US", natural)).toBe("6:05 AM");
    expect(formatClockTime(evening, "en-US", { timeZone: "UTC" })).toBe("06:00 PM");
    expect(formatClockTime(evening, "pl-PL", natural)).toBe("18:00");
    expect(formatClockTime(morning, "pl-PL", natural)).toBe("06:05");
    expect(formatClockTime(evening, "en-GB", natural)).toBe("18:00");
  });
});

describe("number formatting without Intl.NumberFormat.formatToParts (Hermes on iOS)", () => {
  beforeEach(() => setNumberPartsForTests(false));
  afterEach(() => setNumberPartsForTests(null));

  it.each(["pl-PL", "en-US", "en-GB", "de-DE", "ar-EG", "en-IN"])(
    "matches Intl for currency, percent and decimal values in %s",
    (locale) => {
      for (const currency of ["PLN", "USD", "EUR", "JPY"]) {
        const expected = new Intl.NumberFormat(locale, { style: "currency", currency });
        for (const value of [0, 1, -1, 0.125, -0.125, 1000, 1234, 12345.5, 1234567.125]) {
          expect(formatDecimalValue(D(String(value)), locale, { currency }).text).toBe(
            expected.format(value),
          );
        }
      }
      const percent = new Intl.NumberFormat(locale, {
        style: "percent",
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      expect(formatDecimalValue(D("0.1234"), locale, { percent: true }).text).toBe(
        percent.format(0.1234),
      );
      const plain = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      expect(formatDecimalValue(D("-9876543.21"), locale).text).toBe(plain.format(-9876543.21));
      const signed = new Intl.NumberFormat(locale, {
        style: "currency",
        currency: "PLN",
        signDisplay: "exceptZero",
      });
      expect(formatDecimalValue(D("42"), locale, { currency: "PLN", signed: true }).text).toBe(
        signed.format(42),
      );
    },
  );

  it("groups a very long integer by hand", () => {
    expect(formatDecimalValue(D("12345678901234567890"), "en-US", { currency: "USD" }).text).toBe(
      new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
        BigInt("12345678901234567890"),
      ),
    );
  });

  it("fills a one-digit template by position", () => {
    expect(fillNumberTemplate("-PLN 1.00", "1,234", "56", 2)).toBe("-PLN 1,234.56");
    expect(fillNumberTemplate("1,00 z\u0142", "12 345", "05", 2)).toBe("12 345,05 z\u0142");
    expect(fillNumberTemplate("0.0%", "12", "3", 1)).toBe("12.3%");
    expect(fillNumberTemplate("PLN 1", "999", "", 0)).toBe("PLN 999");
  });
});

describe("appClockLocale", () => {
  it("writes times on 24 h and dates day first in both languages, whatever the English region", () => {
    const at = new Date(2026, 10, 14, 19, 40);
    for (const locale of ["en-US", "en", "en-GB", "en-AU"]) {
      expect(formatClockTime(at, appClockLocale(locale))).toBe("19:40");
      expect(formatCalendarDate("2026-11-14", appClockLocale(locale))).toBe("14 Nov 2026");
    }
    expect(formatClockTime(at, appClockLocale("pl-PL"))).toBe("19:40");
    expect(formatCalendarDate("2026-11-14", appClockLocale("pl"))).toBe("14 lis 2026");
  });
});
