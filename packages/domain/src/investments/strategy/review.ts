/**
 * The schedule of the owner's periodic review (`review_schedule` of `service/views.py`): which day a
 * `review:` policy falls on and whether a review is due.
 */

import {
  addDays,
  daysBetween,
  formatDate,
  type IsoDate,
  isoWeekday,
  parseDate,
} from "../../dates.js";
import type { ReviewEvery } from "./config.js";

/** The latest date on/before `day` falling on `isoWeekday` (Monday = 1). */
function lastWeekday(day: IsoDate, weekday: number): IsoDate {
  return addDays(day, -mod(isoWeekday(day) - weekday, 7));
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): IsoDate {
  const first = formatDate({ year, month, day: 1 });
  return addDays(first, mod(weekday - isoWeekday(first), 7));
}

/** The latest scheduled review day on/before `day`: that weekday, or the month's first such weekday. */
function reviewDayOnOrBefore(day: IsoDate, every: ReviewEvery, weekday: number): IsoDate {
  if (every !== "month") return lastWeekday(day, weekday);
  const { year, month } = parseDate(day);
  const first = firstWeekdayOfMonth(year, month, weekday);
  if (first <= day) return first;
  const prev = parseDate(addDays(formatDate({ year, month, day: 1 }), -1));
  return firstWeekdayOfMonth(prev.year, prev.month, weekday);
}

/**
 * `review_schedule`: `[due, nextOn]`. Due when the latest scheduled day on/before `today` comes after
 * the last review (`2weeks`: and more than a week after it); `nextOn` = the first scheduled day after
 * a review done today.
 */
export function reviewSchedule(
  every: ReviewEvery,
  weekday: number,
  today: IsoDate,
  lastDone: IsoDate | null,
): readonly [boolean, IsoDate] {
  const scheduled = reviewDayOnOrBefore(today, every, weekday);
  const due =
    lastDone === null ||
    (scheduled > lastDone && (every !== "2weeks" || daysBetween(lastDone, scheduled) > 7));
  let day = addDays(today, 1);
  for (;;) {
    const on = reviewDayOnOrBefore(day, every, weekday);
    if (on === day && (every !== "2weeks" || daysBetween(today, day) > 7)) return [due, day];
    day = addDays(day, 1);
  }
}

function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
