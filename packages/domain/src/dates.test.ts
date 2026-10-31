import { describe, expect, it } from "vitest";
import { addDays, formatDate, PyValueError, parseDate, toOrdinal } from "./dates.js";

describe("parseDate strictness", () => {
  it.each([
    "",
    "2024-1-01",
    "2024-01-1",
    "24-01-01",
    "2024/01/01",
    "2024-01-01\n",
    " 2024-01-01",
    "2024-01-011",
    "2024-01-0a",
    "202a-01-01",
    "٢024-01-01",
    "２０２４-01-01",
    "0000-01-01",
    "2024-00-10",
    "2024-13-10",
    "2024-02-30",
    "2023-02-29",
    "2024-04-31",
    "2024-01-00",
  ])("refuses %j", (text) => {
    expect(() => parseDate(text)).toThrow(PyValueError);
    expect(() => toOrdinal(text)).toThrow(PyValueError);
  });

  it("parses valid dates and round-trips them through the ordinal", () => {
    expect(parseDate("2024-02-29")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDate("0001-01-01")).toEqual({ year: 1, month: 1, day: 1 });
    expect(parseDate("9999-12-31")).toEqual({ year: 9999, month: 12, day: 31 });
    expect(toOrdinal("0001-01-01")).toBe(1);
    expect(toOrdinal("9999-12-31")).toBe(3652059);
    expect(toOrdinal("2026-10-31")).toBe(toOrdinal({ year: 2026, month: 10, day: 31 }));
    expect(addDays("2024-02-28", 2)).toBe("2024-03-01");
    expect(formatDate({ year: 7, month: 3, day: 9 })).toBe("0007-03-09");
    expect(formatDate({ year: 999, month: 12, day: 31 })).toBe("0999-12-31");
    expect(formatDate({ year: 2026, month: 10, day: 1 })).toBe("2026-10-01");
  });
});
