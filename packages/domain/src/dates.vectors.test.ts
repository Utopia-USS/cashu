import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  formatDateTime,
  fromIsoCalendar,
  fromIsoFormat,
  fromOrdinal,
  isoCalendar,
  isoWeekday,
  isoWeekLabel,
  monthsBack,
  PyOverflowError,
  PyValueError,
  parseDate,
  parseDateTime,
  toOrdinal,
  toStorage,
  utcIso,
  weekday,
  weekStart,
} from "./dates.js";
import { loadVectors, Mismatches, outcome } from "./testing/vectors.js";

const pyError = (error: unknown) =>
  error instanceof PyValueError
    ? "ValueError"
    : error instanceof PyOverflowError
      ? "OverflowError"
      : null;
const run = <T>(fn: () => T) => outcome(fn, pyError);

describe("date vectors (parity/python/vectors.py)", () => {
  it("calendar math like datetime / relativedelta", () => {
    const m = new Mismatches();
    for (const row of loadVectors("dates").rows) {
      const op = row[0] as string;
      const label = JSON.stringify(row.slice(0, -1));
      const expected = row[row.length - 1];
      switch (op) {
        case "info": {
          const d = row[1] as string;
          const { year, month } = parseDate(d);
          m.check(
            label,
            [
              toOrdinal(d),
              weekday(d),
              isoWeekday(d),
              isoCalendar(d),
              isoWeekLabel(d),
              toOrdinal(d) > 7 ? weekStart(d) : null,
              daysInMonth(year, month),
            ],
            row.slice(2),
          );
          m.check(`fromordinal ${d}`, fromOrdinal(toOrdinal(d)), d);
          break;
        }
        case "add_months":
          m.check(
            label,
            run(() => addMonths(row[1] as string, row[2] as number)),
            expected,
          );
          break;
        case "months_back":
          m.check(
            label,
            run(() => monthsBack(row[1] as string, row[2] as number)),
            expected,
          );
          break;
        case "add_days":
          m.check(
            label,
            run(() => addDays(row[1] as string, row[2] as number)),
            expected,
          );
          break;
        case "days_between":
          m.check(label, daysBetween(row[1] as string, row[2] as string), expected);
          break;
        case "fromisocalendar":
          m.check(
            label,
            run(() => fromIsoCalendar(row[1] as number, row[2] as number, row[3] as number)),
            expected,
          );
          break;
        case "fromisoformat":
          m.check(
            label,
            run(() => fromIsoFormat(row[1] as string)),
            expected,
          );
          break;
        default:
          throw new Error(`unknown op ${op}`);
      }
    }
    expect(m.checked).toBeGreaterThan(28000);
    expect(m.items, m.report()).toEqual([]);
  });

  it("timestamps: fromisoformat, isoformat, utc_iso, naive UTC storage", () => {
    const m = new Mismatches();
    for (const [text, iso, utc, storage] of loadVectors("datetimes").rows) {
      const parsed = parseDateTime(text as string);
      m.check(`isoformat ${text}`, formatDateTime(parsed), iso);
      m.check(`utc_iso ${text}`, utcIso(parsed), utc);
      m.check(`storage ${text}`, toStorage(parsed), storage);
    }
    expect(m.items, m.report()).toEqual([]);
  });
});
