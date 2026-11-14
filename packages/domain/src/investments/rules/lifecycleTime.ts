/** Exact datetime operations for lifecycle.py, including Python's naive/aware distinction. */
import { type DateTime, fromOrdinal, PyOverflowError, toOrdinal } from "../../dates.js";

const DAY = 86_400_000_000n;
const LAST = BigInt(toOrdinal("9999-12-31")) * DAY;

function wall(value: DateTime): bigint {
  return (
    BigInt(toOrdinal(value.date) - 1) * DAY +
    BigInt(value.hour * 3600 + value.minute * 60 + value.second) * 1_000_000n +
    BigInt(value.microsecond)
  );
}

function instant(value: DateTime): bigint {
  return wall(value) - BigInt((value.offsetSeconds ?? 0) * 1_000_000);
}

/** Python compares two naive values or two aware values, never one of each. */
export function elapsedMicros(later: DateTime, earlier: DateTime): bigint {
  if ((later.offsetSeconds === null) !== (earlier.offsetSeconds === null)) {
    throw new TypeError("can't compare offset-naive and offset-aware datetimes");
  }
  return instant(later) - instant(earlier);
}

/** Python timedelta(days=n), with exact integer days and half-even fractional microseconds. */
export function dayMicros(days: number): bigint {
  if (!Number.isFinite(days)) throw new PyOverflowError("cannot convert non-finite days");
  const whole = Math.trunc(days);
  const fractional = (days - whole) * Number(DAY);
  const floor = Math.floor(fractional);
  const rest = fractional - floor;
  const rounded = rest > 0.5 || (rest === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return BigInt(whole) * DAY + BigInt(rounded);
}

/** Wall-clock addition keeps the original offset, as datetime + timedelta does. */
export function plusDays(value: DateTime, days: number): DateTime {
  const at = wall(value) + dayMicros(days);
  if (at < 0n || at >= LAST) throw new PyOverflowError("date value out of range");
  const rest = at % DAY;
  const seconds = Number(rest / 1_000_000n);
  return {
    date: fromOrdinal(Number(at / DAY) + 1),
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    second: seconds % 60,
    microsecond: Number(rest % 1_000_000n),
    offsetSeconds: value.offsetSeconds,
  };
}
