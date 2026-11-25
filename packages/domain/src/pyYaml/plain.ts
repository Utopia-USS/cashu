/**
 * The Python values `SafeConstructor` builds from a node tree (what `yaml.safe_load` returns), as plain
 * TS data that keeps the distinctions Python code tests with `isinstance`: an `int` is a `bigint`
 * (arbitrary precision), a `float` a `number`, `bool` a `boolean`, `None` `null`, a `dict` a `Map`
 * (insertion order, text keys), a `list` an array, `datetime.date` / `datetime.datetime` the classes
 * below. `pyStr` / `pyRepr` render them like Python's `str()` / `repr()`.
 */

import { floatRepr } from "../decimal.js";
import { pyReprStr } from "../pyRepr.js";

/** `datetime.date`. */
export class PyDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;

  constructor(year: number, month: number, day: number) {
    this.year = year;
    this.month = month;
    this.day = day;
  }

  /** `date.isoformat()`. */
  isoformat(): string {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  /** `repr(date)`. */
  repr(): string {
    return `datetime.date(${this.year}, ${this.month}, ${this.day})`;
  }
}

/** `datetime.datetime`; `offsetMinutes` null = naive, else a fixed `timezone(timedelta(...))`. */
export class PyDateTime extends PyDate {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly offsetMinutes: number | null;

  constructor(
    ymd: readonly [number, number, number],
    hms: readonly [number, number, number],
    microsecond: number,
    offsetMinutes: number | null,
  ) {
    super(ymd[0], ymd[1], ymd[2]);
    [this.hour, this.minute, this.second] = hms;
    this.microsecond = microsecond;
    this.offsetMinutes = offsetMinutes;
  }

  /** `datetime.isoformat(sep)`: microseconds only when non-zero, the offset as `+HH:MM`. */
  override isoformat(sep = "T"): string {
    let out = `${super.isoformat()}${sep}${pad(this.hour, 2)}:${pad(this.minute, 2)}:${pad(this.second, 2)}`;
    if (this.microsecond !== 0) out += `.${pad(this.microsecond, 6)}`;
    if (this.offsetMinutes !== null) {
      const sign = this.offsetMinutes < 0 ? "-" : "+";
      const total = Math.abs(this.offsetMinutes);
      out += `${sign}${pad(Math.floor(total / 60), 2)}:${pad(total % 60, 2)}`;
    }
    return out;
  }

  /** `repr(datetime)`: trailing zero seconds / microseconds left out, the tzinfo's repr. */
  override repr(): string {
    const parts = [this.year, this.month, this.day, this.hour, this.minute];
    if (this.second !== 0 || this.microsecond !== 0) parts.push(this.second);
    if (this.microsecond !== 0) parts.push(this.microsecond);
    let out = `datetime.datetime(${parts.join(", ")}`;
    if (this.offsetMinutes !== null) out += `, tzinfo=${timezoneRepr(this.offsetMinutes)}`;
    return `${out})`;
  }
}

/** A value `SafeConstructor` (scalars, `seq`, `map`) produces. */
export type PyPlain =
  | null
  | boolean
  | bigint
  | number
  | string
  | PyDate
  | readonly PyPlain[]
  | PyPlainMap;

export type PyPlainMap = ReadonlyMap<string, PyPlain>;

/** `isinstance(value, int | float) and not isinstance(value, bool)`. */
export function isPyNumber(value: PyPlain | undefined): value is bigint | number {
  return typeof value === "bigint" || typeof value === "number";
}

/** `isinstance(value, Mapping)`. */
export function isPyMap(value: PyPlain | undefined): value is PyPlainMap {
  return value instanceof Map;
}

/** `str(value)`. */
export function pyStr(value: PyPlain): string {
  if (typeof value === "string") return value;
  if (value instanceof PyDateTime) return value.isoformat(" ");
  if (value instanceof PyDate) return value.isoformat();
  return pyRepr(value);
}

/** `repr(value)`. */
function pyRepr(value: PyPlain): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return floatRepr(value);
  if (typeof value === "string") return pyReprStr(value);
  if (value instanceof PyDate) return value.repr();
  if (value instanceof Map) {
    const items = [...value].map(([k, v]) => `${pyReprStr(k)}: ${pyRepr(v)}`);
    return `{${items.join(", ")}}`;
  }
  return `[${(value as readonly PyPlain[]).map(pyRepr).join(", ")}]`;
}

/** `repr(datetime.timezone(timedelta(minutes=offset)))` (offset 0 is the `utc` singleton). */
function timezoneRepr(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "datetime.timezone.utc";
  return `datetime.timezone(${timedeltaRepr(offsetMinutes * 60)})`;
}

/** `repr(timedelta(seconds=s))`: normalized to days (floor) and non-negative seconds. */
function timedeltaRepr(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const rest = seconds - days * 86400;
  const parts: string[] = [];
  if (days !== 0) parts.push(`days=${days}`);
  if (rest !== 0) parts.push(`seconds=${rest}`);
  return `datetime.timedelta(${parts.length === 0 ? "0" : parts.join(", ")})`;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
