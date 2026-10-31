import { describe, expect, it } from "vitest";
import type { Decimal } from "../../decimal.js";
import {
  datePattern,
  decimalFormat,
  parseDatetimeWithPatterns,
  parseDateWithPatterns,
  parseDecimal,
  tryParseDate,
  tryParseDatetime,
} from "./csvValues.js";
import { d, day, enc, encodeCp1250, plExportCp1250, plExportUtf8Bom } from "./testing/support.js";
import { decodeImportText, hasUtf8Bom, ImportTextEncoding, parseEncoding } from "./text.js";

// Translation of tests/investments/importing/test_imp_text_values.py (text decoding and cell values).
const POLISH = "ĄĆĘŁŃÓŚŹŻąćęłńóśźż";

const text = (data: Uint8Array, encoding: ImportTextEncoding, lenient = false): string => {
  const decoded = decodeImportText(data, encoding, { lenient });
  if (!decoded.ok) throw new Error(`${decoded.reason} at byte ${decoded.start}`);
  return decoded.text;
};
const decimal = (fmt: ReturnType<typeof decimalFormat>, raw: string): Decimal | null => {
  const parsed = parseDecimal(fmt, raw);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const same = (value: Decimal | null, expected: string) => value?.eq(d(expected)) === true;

describe("text decoding", () => {
  // test_windows_1250_decodes_every_polish_letter
  it("windows-1250 decodes every Polish letter", () => {
    const expected: Record<number, string> = {
      165: "Ą",
      198: "Ć",
      202: "Ę",
      163: "Ł",
      209: "Ń",
      211: "Ó",
      140: "Ś",
      143: "Ź",
      175: "Ż",
      185: "ą",
      230: "ć",
      234: "ę",
      179: "ł",
      241: "ń",
      243: "ó",
      156: "ś",
      159: "ź",
      191: "ż",
    };
    for (const [byte, letter] of Object.entries(expected)) {
      expect(text(Uint8Array.of(Number(byte)), ImportTextEncoding.WINDOWS_1250)).toBe(letter);
    }
  });

  // test_windows_1250_round_trip_and_undefined_bytes
  it("windows-1250 round trip and undefined bytes", () => {
    const sample = `Zażółć gęślą jaźń ${POLISH} ascii 123`;
    expect(text(encodeCp1250(sample), ImportTextEncoding.WINDOWS_1250)).toBe(sample);
    expect(text(Uint8Array.of(0x81, 0x41), ImportTextEncoding.WINDOWS_1250)).toBe("�A");
  });

  // test_utf8_bom_is_stripped
  it("utf-8 BOM is stripped", () => {
    expect(hasUtf8Bom(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63))).toBe(true);
    expect(text(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63), ImportTextEncoding.UTF8)).toBe(
      "abc",
    );
    expect(text(enc("﻿abc"), ImportTextEncoding.UTF8)).toBe("abc");
  });

  // test_malformed_utf8_raises_unless_lenient
  it("malformed utf-8 fails unless lenient", () => {
    const bad = Uint8Array.of(0x61, 0x62, 0xff);
    expect(decodeImportText(bad, ImportTextEncoding.UTF8)).toEqual({
      ok: false,
      reason: "invalid start byte",
      start: 2,
    });
    expect(text(bad, ImportTextEncoding.UTF8, true)).toBe("ab�");
  });

  // test_auto_picks_utf8_or_windows_1250
  it("auto picks utf-8 or windows-1250", () => {
    expect(text(enc("łódź"), ImportTextEncoding.AUTO)).toBe("łódź");
    expect(text(encodeCp1250("łódź"), ImportTextEncoding.AUTO)).toBe("łódź");
  });

  // test_both_fixture_encodings_decode_to_the_same_text
  it("both fixture encodings decode to the same text", () => {
    const utf8 = text(plExportUtf8Bom(), ImportTextEncoding.UTF8);
    const cp1250 = text(plExportCp1250(), ImportTextEncoding.WINDOWS_1250);
    expect(utf8.replaceAll("\r\n", "\n")).toBe(cp1250);
  });

  // test_encoding_names
  it("encoding names", () => {
    expect(parseEncoding("UTF-8")).toBe(ImportTextEncoding.UTF8);
    expect(parseEncoding("utf8")).toBe(ImportTextEncoding.UTF8);
    expect(parseEncoding("cp1250")).toBe(ImportTextEncoding.WINDOWS_1250);
    expect(parseEncoding(" Windows-1250 ")).toBe(ImportTextEncoding.WINDOWS_1250);
    expect(parseEncoding("auto")).toBe(ImportTextEncoding.AUTO);
    expect(parseEncoding("latin2")).toBeNull();
  });
});

describe("decimals", () => {
  // test_decimal_comma_with_space_thousands_including_no_break_spaces
  it("decimal comma with space thousands, including no-break spaces", () => {
    const fmt = decimalFormat(",", " ");
    expect(same(decimal(fmt, "1 234,56"), "1234.56")).toBe(true);
    expect(same(decimal(fmt, "1 234,56"), "1234.56")).toBe(true);
    expect(same(decimal(fmt, "1 234,56"), "1234.56")).toBe(true);
    expect(decimal(fmt, "  ")).toBeNull();
    expect(same(decimal(fmt, "12,"), "12")).toBe(true);
  });

  // test_decimal_separators_variants
  it("separator variants", () => {
    expect(same(decimal(decimalFormat(",", "."), "1.234,56"), "1234.56")).toBe(true);
    expect(same(decimal(decimalFormat(".", ","), "-1,234.56"), "-1234.56")).toBe(true);
    expect(same(decimal(decimalFormat(), ".5"), "0.5")).toBe(true);
  });

  // test_decimal_signs
  it("signs", () => {
    const fmt = decimalFormat(",");
    expect(same(decimal(fmt, "−12,50"), "-12.5")).toBe(true);
    expect(same(decimal(fmt, "12,50-"), "-12.5")).toBe(true);
    expect(same(decimal(fmt, "(12,50)"), "-12.5")).toBe(true);
    expect(same(decimal(fmt, "+3"), "3")).toBe(true);
  });

  // test_decimal_rejects_non_numbers[abc, 1.234,56, 1e5, NaN, Infinity, 12 34, 1,2,3]
  it.each(["abc", "1.234,56", "1e5", "NaN", "Infinity", "12 34", "1,2,3"])("rejects %j", (raw) => {
    const parsed = parseDecimal(decimalFormat(","), raw);
    expect(parsed.ok).toBe(false);
  });

  it("names the refusal like Python", () => {
    const fmt = decimalFormat(",");
    expect(parseDecimal(fmt, "1.234,56")).toEqual({
      ok: false,
      message: `Unexpected "." in a number with decimal ",": '1.234,56'`,
    });
    expect(parseDecimal(fmt, "abc")).toEqual({ ok: false, message: "Not a number: 'abc'" });
  });

  // test_decimal_format_validates_separators
  it("format validates separators", () => {
    expect(() => decimalFormat(";")).toThrow();
    expect(() => decimalFormat(",", ",")).toThrow();
  });
});

describe("dates", () => {
  // test_date_patterns
  it("date patterns", () => {
    expect(tryParseDate(datePattern("dd.MM.yyyy"), "05.01.2026")).toBe(day("2026-01-05"));
    expect(tryParseDate(datePattern("yyyy-MM-dd"), "2026-01-05")).toBe(day("2026-01-05"));
    expect(tryParseDate(datePattern("d/M/yyyy"), "5/1/2026")).toBe(day("2026-01-05"));
    expect(tryParseDate(datePattern("yyyy-MM-dd"), "2026-01-05 10:22")).toBe(day("2026-01-05"));
    expect(tryParseDate(datePattern("yyyy-MM-dd HH:mm:ss"), "2026-01-05 10:22:01")).toBe(
      day("2026-01-05"),
    );
  });

  // test_time_of_day_is_kept_as_sort_key_r9
  it("time of day is kept as a sort key (R9)", () => {
    const pattern = datePattern("yyyy-MM-dd");
    expect(tryParseDatetime(pattern, "2026-09-02 15:00")).toEqual({
      date: "2026-09-02",
      time: { hour: 15, minute: 0, second: 0 },
    });
    expect(tryParseDatetime(pattern, "2026-09-02T09:05:07")).toEqual({
      date: "2026-09-02",
      time: { hour: 9, minute: 5, second: 7 },
    });
    expect(tryParseDatetime(pattern, "2026-09-02")).toEqual({ date: "2026-09-02", time: null });
    expect(tryParseDatetime(pattern, "2026-09-02 25:00")).toEqual({
      date: "2026-09-02",
      time: null,
    });
    const timed = datePattern("dd.MM.yyyy HH:mm");
    expect(tryParseDatetime(timed, "02.09.2026 08:30")).toEqual({
      date: "2026-09-02",
      time: { hour: 8, minute: 30, second: 0 },
    });
  });

  // test_non_matching_and_impossible_dates
  it("non matching and impossible dates", () => {
    expect(tryParseDate(datePattern("yyyy-MM-dd"), "05.01.2026")).toBeNull();
    expect(tryParseDate(datePattern("yyyy-MM-dd"), "2026-02-30")).toBeNull();
    expect(tryParseDate(datePattern("yyyy-MM-dd"), "2026-1-5")).toBeNull();
  });

  // test_a_pattern_needs_year_month_and_day
  it("a pattern needs year, month and day", () => {
    expect(() => datePattern("MM.yyyy")).toThrow();
  });

  // test_patterns_are_tried_in_order
  it("patterns are tried in order", () => {
    const patterns = [datePattern("dd.MM.yyyy"), datePattern("yyyy-MM-dd")];
    expect(parseDateWithPatterns("2026-01-05", patterns)).toEqual({
      ok: true,
      value: day("2026-01-05"),
    });
    expect(parseDateWithPatterns(" ", patterns)).toEqual({ ok: true, value: null });
    expect(parseDatetimeWithPatterns("05.01.2026 07:00", patterns)).toEqual({
      ok: true,
      value: { date: day("2026-01-05"), time: { hour: 7, minute: 0, second: 0 } },
    });
    const refused = parseDateWithPatterns("Jan 5", patterns);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.message).toContain("dd.MM.yyyy / yyyy-MM-dd");
  });
});
