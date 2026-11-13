// Local wall-clock times as instants: "19:00 in Europe/Warsaw on 2026-10-25" as the UTC ISO instant the
// OS schedules. Pure: the zone's offsets come from `Intl.DateTimeFormat` (Hermes has it), never from
// the device clock.
import { addDays, addMonths, type IsoDate, parseDate, weekday } from "../../dates.js";
import {
  EVENING_HOUR,
  MONTH_CLOSED_HOUR,
  SCHEDULE_MARGIN_MS,
  WEEKLY_HOUR,
  WEEKLY_WEEKDAY,
} from "./thresholds.js";
import type { YearMonth } from "./types.js";

const partFormats = new Map<string, Intl.DateTimeFormat>();
function partsFormat(timeZone: string): Intl.DateTimeFormat {
  let format = partFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partFormats.set(timeZone, format);
  }
  return format;
}

interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** The wall clock of an instant in `timeZone`. */
function wallClock(epochMs: number, timeZone: string): WallClock {
  const out: Record<string, number> = {};
  for (const part of partsFormat(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== "literal") out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    // Some engines write midnight as 24 even with h23.
    hour: (out.hour ?? 0) % 24,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in ms. */
function zoneOffset(epochMs: number, timeZone: string): number {
  const w = wallClock(epochMs, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * The instant of `hour:minute` local time in `timeZone`, `dayOffset` days after `today` (YYYY-MM-DD).
 * A wall time skipped by a DST jump moves forward by the jump (02:30 on a spring-forward night
 * fires at 03:30).
 */
export function localFireAt(
  today: IsoDate,
  hour: number,
  minute: number,
  timeZone: string,
  dayOffset = 0,
): string {
  const { year, month, day } = parseDate(addDays(today, dayOffset));
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes: the offset at the first guess can differ from the offset at the answer across a DST change.
  const first = wall - zoneOffset(wall, timeZone);
  const second = wall - zoneOffset(first, timeZone);
  return new Date(second).toISOString();
}

/** The local calendar day (YYYY-MM-DD) of an ISO instant in `timeZone`. */
export function localDate(instant: string, timeZone: string): IsoDate {
  const w = wallClock(Date.parse(instant), timeZone);
  return `${String(w.year).padStart(4, "0")}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** The weekday of a calendar day, 0 = Sunday (as `Date.getDay`). */
export function dayOfWeek(date: IsoDate): number {
  return (weekday(date) + 1) % 7;
}

/** True when `fireAt` is far enough ahead of `now` for the OS to schedule it. */
export function isAhead(fireAt: string, now: string, marginMs = SCHEDULE_MARGIN_MS): boolean {
  return Date.parse(fireAt) > Date.parse(now) + marginMs;
}

/**
 * Days from `today` to the evening digest's day: 0 while today's 19:00 is ahead, else 1 (tomorrow
 * evening). The digest speaks about the day after its own: its bills are due `offset + 1` days from today.
 */
export function eveningDigestOffset(today: IsoDate, now: string, timeZone: string): 0 | 1 {
  return isAhead(localFireAt(today, EVENING_HOUR, 0, timeZone), now) ? 0 : 1;
}

/**
 * Days from `today` to the weekly digest's day: the next Sunday, or today while its 18:00 is still ahead.
 * Its "next week" is the 7 days after that day.
 */
export function weeklyDigestOffset(today: IsoDate, now: string, timeZone: string): number {
  const offset = (WEEKLY_WEEKDAY - dayOfWeek(today) + 7) % 7;
  if (offset > 0) return offset;
  return isAhead(localFireAt(today, WEEKLY_HOUR, 0, timeZone), now) ? 0 : 7;
}

/** The first day of the month after `month` (YYYY-MM), the month-closed digest's day. */
export function monthClosedDay(month: YearMonth): IsoDate {
  return addMonths(`${month}-01`, 1);
}

/** The month-closed digest's fire time: the 1st of the month after `month` at 09:00 local. */
export function monthClosedFireAt(month: YearMonth, timeZone: string): string {
  return localFireAt(monthClosedDay(month), MONTH_CLOSED_HOUR, 0, timeZone);
}
