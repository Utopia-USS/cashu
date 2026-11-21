/**
 * An aware UTC instant as research uses Python's `datetime` (always converted to UTC): integer
 * microseconds since 0001-01-01T00:00:00Z as a `bigint`, so comparisons and `timedelta` arithmetic
 * are exact over Python's whole range (a `number` is exact only within ~285 years).
 */

import { fromOrdinal, type IsoDate, MAXYEAR, PyOverflowError, toOrdinal } from "../../dates.js";

export type Instant = bigint;

export const MICROS_PER_SECOND = 1_000_000n;
export const MICROS_PER_DAY = 86_400n * MICROS_PER_SECOND;
const MAX_INSTANT = BigInt(toOrdinal(`${MAXYEAR}-12-31`)) * MICROS_PER_DAY - 1n;

function pad(n: bigint | number, width: number): string {
  return String(n).padStart(width, "0");
}

/** The instant at UTC `date` + time of day (Python `datetime(..., tzinfo=UTC)`). */
export function utcInstant(
  date: IsoDate,
  hour = 0,
  minute = 0,
  second = 0,
  microsecond = 0,
): Instant {
  const seconds = BigInt(hour * 3600 + minute * 60 + second);
  return (
    BigInt(toOrdinal(date) - 1) * MICROS_PER_DAY + seconds * MICROS_PER_SECOND + BigInt(microsecond)
  );
}

/**
 * A local wall time with a UTC offset in microseconds as an instant (Python `astimezone(UTC)`).
 * Throws `PyOverflowError` outside years 1..9999, like Python.
 */
export function instantFromLocal(local: Instant, offsetMicros: bigint): Instant {
  const value = local - offsetMicros;
  if (value < 0n || value > MAX_INSTANT) throw new PyOverflowError("date value out of range");
  return value;
}

/** Python `timedelta(days=n)` in microseconds (`n` may be fractional: rounded half to even). */
export function days(n: number): bigint {
  return micros(n * 86_400_000_000);
}

/** Python `timedelta(hours=n)` in microseconds. */
export function hours(n: number): bigint {
  return micros(n * 3_600_000_000);
}

function micros(x: number): bigint {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5 || (diff === 0.5 && floor % 2 !== 0)) return BigInt(floor + 1);
  return BigInt(floor);
}

/** The UTC calendar date of `at` (Python `at.date()`). */
export function instantDate(at: Instant): IsoDate {
  return fromOrdinal(Number(at / MICROS_PER_DAY) + 1);
}

/** True when `at` is midnight UTC (Python `at.time() == time()`). */
export function isMidnight(at: Instant): boolean {
  return at % MICROS_PER_DAY === 0n;
}

/** Python `at.isoformat()` of an aware UTC datetime: `2026-10-03T08:00:00[.ffffff]+00:00`. */
export function formatInstant(at: Instant): string {
  const inDay = at % MICROS_PER_DAY;
  const totalSeconds = inDay / MICROS_PER_SECOND;
  const micro = inDay % MICROS_PER_SECOND;
  const hh = totalSeconds / 3600n;
  const mm = (totalSeconds % 3600n) / 60n;
  const ss = totalSeconds % 60n;
  const fraction = micro === 0n ? "" : `.${pad(micro, 6)}`;
  return `${instantDate(at)}T${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}${fraction}+00:00`;
}
