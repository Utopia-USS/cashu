import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysBetween,
  formatDate,
  fromIsoCalendar,
  fromIsoFormat,
  isoCalendar,
  isoWeekLabel,
  monthsBack,
  PyValueError,
  parseDate,
  toOrdinal,
  toStorage,
  utcIso,
  weekday,
  weekStart,
} from "./dates.js";

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

describe("calendar math", () => {
  it("adds and subtracts months clamping to the month end, refusing year 0", () => {
    expect(addMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(addMonths("2023-01-31", 1)).toBe("2023-02-28");
    expect(addMonths("2024-01-31", 12)).toBe("2025-01-31");
    expect(monthsBack("2024-03-31", 1)).toBe("2024-02-29");
    expect(() => addMonths("0001-01-01", -12)).toThrow(PyValueError);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
  });

  it("ISO weeks: Monday start, week 1 holds the first Thursday", () => {
    expect(weekday("2024-01-31")).toBe(2);
    expect(isoCalendar("2024-12-31")).toEqual([2025, 1, 2]);
    expect(isoWeekLabel("2024-12-31")).toBe("2025-W01");
    expect(isoWeekLabel("2024-01-31")).toBe("2024-W05");
    expect(weekStart("2024-01-31")).toBe("2024-01-29");
    expect(fromIsoCalendar(2009, 1, 3)).toBe("2008-12-31");
    expect(() => fromIsoCalendar(2001, 53, 1)).toThrow(PyValueError);
  });

  it("fromisoformat accepts the date forms Python 3.11+ does, nothing else", () => {
    expect(fromIsoFormat("2026-01-01")).toBe("2026-01-01");
    for (const bad of ["2026-W00", "+2026-01-01", "00000101"])
      expect(() => fromIsoFormat(bad), bad).toThrow(PyValueError);
  });
});

describe("timestamps", () => {
  it("normalizes offsets to UTC for display and naive UTC storage", () => {
    expect(utcIso("2008-05-18 15:13:13")).toBe("2008-05-18T15:13:13+00:00");
    expect(utcIso("2021-01-01 12:18:31+14:00")).toBe("2020-12-31T22:18:31+00:00");
    expect(utcIso("2004-10-16T05:10:42Z")).toBe("2004-10-16T05:10:42+00:00");
    expect(toStorage("2027-09-16 20:53:46.069000-05:00")).toBe("2027-09-17 01:53:46.069000");
    expect(toStorage("2052-02-29T13:50:58+14:00")).toBe("2052-02-28 23:50:58.000000");
  });
});
