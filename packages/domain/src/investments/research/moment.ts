/**
 * `validation.parse_moment`: an ISO date (`2026-10-03` = midnight UTC) or an ISO timestamp (naive =
 * UTC) as an aware UTC instant, with Python's exact acceptance: `date.fromisoformat` for up to 10
 * characters, else the C implementation of `datetime.fromisoformat` (CPython 3.14
 * `Modules/_datetimemodule.c`: any single character separates date and time, `HH[:MM[:SS[.f]]]`
 * with or without colons, `Z` or a `+-HH[:MM[:SS[.f]]]` offset, `24:00` as the next midnight).
 */

import {
  checkYmd,
  daysInMonth,
  formatDate,
  fromIsoCalendar,
  fromIsoFormat,
  type IsoDate,
  PyValueError,
} from "../../dates.js";
import { pyStrip } from "../../text.js";
import { type Instant, instantFromLocal, MICROS_PER_DAY, utcInstant } from "./instant.js";

const ZERO = 0x30;

/** UTF-8 bytes of `text`, or null when it holds a lone surrogate (Python cannot encode it). */
function utf8(text: string): number[] | null {
  const out: number[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) return null;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
  }
  return out;
}

/** A C string view: reading at or past the end gives the terminating NUL. */
class Bytes {
  // a plain field, not a parameter property: the parity producers load the domain in Node's
  // strip-only TypeScript mode, which refuses parameter properties
  readonly data: readonly number[];

  constructor(data: readonly number[]) {
    this.data = data;
  }

  at(i: number): number {
    return i >= 0 && i < this.data.length ? (this.data[i] as number) : 0;
  }
  get length(): number {
    return this.data.length;
  }
}

function isDigit(c: number): boolean {
  return c >= ZERO && c <= ZERO + 9;
}

/** `parse_digits`: the value of `n` digits at `p` and the position after, or null. */
function digits(s: Bytes, p: number, n: number): [number, number] | null {
  let value = 0;
  for (let i = 0; i < n; i++) {
    const c = s.at(p + i);
    if (!isDigit(c)) return null;
    value = value * 10 + (c - ZERO);
  }
  return [value, p + n];
}

const CH = (c: string): number => c.charCodeAt(0);

function findSeparator(s: Bytes): number {
  const len = s.length;
  if (len === 7) return 7;
  if (s.at(4) === CH("-")) {
    if (s.at(5) === CH("W")) {
      if (len < 8) return -1;
      if (len > 8 && s.at(8) === CH("-")) {
        if (len === 9) return -1;
        if (len > 10 && isDigit(s.at(10))) return 8;
        return 10;
      }
      return 8;
    }
    return 10;
  }
  if (s.at(4) === CH("W")) {
    let idx = 7;
    for (; idx < len; idx++) if (!isDigit(s.at(idx))) break;
    if (idx < 9) return idx;
    return idx % 2 === 0 ? 7 : 8;
  }
  return 8;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

/** `parse_isoformat_date`: null on a failure code. */
function parseDatePart(s: Bytes, len: number): DateParts | null {
  const y = digits(s, 0, 4);
  if (!y) return null;
  let p = y[1];
  const usesSeparator = s.at(p) === CH("-");
  if (usesSeparator) p++;
  if (s.at(p) === CH("W")) {
    p++;
    const w = digits(s, p, 2);
    if (!w) return null;
    p = w[1];
    let isoDay = 1;
    if (p < len) {
      if (usesSeparator && s.at(p++) !== CH("-")) return null;
      const d = digits(s, p, 1);
      if (!d) return null;
      isoDay = d[0];
    }
    let date: IsoDate;
    try {
      date = fromIsoCalendar(y[0], w[0], isoDay);
    } catch {
      return null;
    }
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    return { year, month, day };
  }
  const m = digits(s, p, 2);
  if (!m) return null;
  p = m[1];
  if (usesSeparator && s.at(p++) !== CH("-")) return null;
  const d = digits(s, p, 2);
  if (!d) return null;
  return { year: y[0], month: m[0], day: d[0] };
}

interface TimeParts {
  hour: number;
  minute: number;
  second: number;
  microsecond: number;
}

const CORRECTION = [100000, 10000, 1000, 100, 10];

/** `parse_hh_mm_ss_ff` between `start` and `end`: [code, parts] (code < 0 = failure). */
function parseHms(s: Bytes, start: number, end: number): [number, TimeParts] {
  const vals = [0, 0, 0];
  const parts = (): TimeParts => ({
    hour: vals[0] as number,
    minute: vals[1] as number,
    second: vals[2] as number,
    microsecond,
  });
  let microsecond = 0;
  let p = start;
  let hasSeparator = true;
  for (let i = 0; i < 3; i++) {
    const v = digits(s, p, 2);
    if (!v) return [-3, parts()];
    vals[i] = v[0];
    p = v[1];
    const c = s.at(p++);
    if (i === 0) hasSeparator = c === CH(":");
    if (p >= end) return [c !== 0 ? 1 : 0, parts()];
    if (hasSeparator && c === CH(":")) {
      if (i === 2) return [-4, parts()];
      continue;
    }
    if (c === CH(".") || c === CH(",")) {
      if (i < 2) return [-3, parts()];
      break;
    }
    if (!hasSeparator) p--;
    else return [-4, parts()];
  }
  const remains = end - p;
  const toParse = Math.min(remains, 6);
  const f = digits(s, p, toParse);
  if (!f) return [-3, parts()];
  microsecond = f[0] * (toParse < 6 ? (CORRECTION[toParse - 1] as number) : 1);
  p = f[1];
  while (isDigit(s.at(p))) p++;
  return [s.at(p) !== 0 ? 1 : 0, parts()];
}

interface ParsedTime extends TimeParts {
  /** null: naive; else the UTC offset in microseconds. */
  offsetMicros: bigint | null;
}

/** `parse_isoformat_time` of `s[start:]`: null on a failure code. */
function parseTimePart(s: Bytes, start: number): ParsedTime | null {
  const end = s.length;
  let tz = start;
  do {
    const c = s.at(tz);
    if (c === CH("Z") || c === CH("+") || c === CH("-")) break;
  } while (++tz < end);
  const [rv, time] = parseHms(s, start, tz);
  if (rv < 0) return null;
  if (tz === end) return rv === 1 ? null : { ...time, offsetMicros: null };
  if (s.at(tz) === CH("Z")) return s.at(tz + 1) !== 0 ? null : { ...time, offsetMicros: 0n };
  const sign = s.at(tz) === CH("-") ? -1n : 1n;
  const [tzRv, offset] = parseHms(s, tz + 1, end);
  if (tzRv !== 0) return null; // rv ? -5 : 1 (a failure code is non-zero too)
  const seconds = BigInt(offset.hour * 3600 + offset.minute * 60 + offset.second);
  // tzinfo_from_isoformat_results: a zero-second offset is UTC (its microseconds are dropped).
  if (seconds === 0n) return { ...time, offsetMicros: 0n };
  return { ...time, offsetMicros: sign * (seconds * 1_000_000n + BigInt(offset.microsecond)) };
}

/**
 * Python `datetime.fromisoformat(text)` (C implementation) as an aware UTC instant (a naive value
 * is taken as UTC). Throws `PyValueError` where Python raises `ValueError`, `PyOverflowError` where
 * the conversion to UTC leaves years 1..9999.
 */
export function datetimeFromIsoformat(text: string): Instant {
  const invalid = () => new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
  const points = Array.from(text);
  if (points.length < 7) throw invalid();
  // _sanitize_isoformat_str: a surrogate at a separator position becomes `T`.
  for (const pos of [7, 8, 10]) {
    if (pos > points.length) break;
    const cp = (points[pos] ?? "").codePointAt(0) ?? 0;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      points[pos] = "T";
      break;
    }
  }
  const bytes = utf8(points.join(""));
  if (bytes === null) throw invalid();
  const s = new Bytes(bytes);
  const sep = findSeparator(s);
  const date = parseDatePart(s, sep < 0 ? Number.MAX_SAFE_INTEGER : sep);
  if (date === null) throw invalid();
  let time: ParsedTime = { hour: 0, minute: 0, second: 0, microsecond: 0, offsetMicros: null };
  if (s.length > sep) {
    if (sep < 0) throw invalid();
    const lead = s.at(sep);
    let p = sep;
    if ((lead & 0x80) === 0) p += 1;
    else if ((lead & 0xf0) === 0xe0) p += 3;
    else if ((lead & 0xf0) === 0xf0) p += 4;
    else p += 2;
    const parsed = parseTimePart(new Bytes(bytes.slice(p)), 0);
    if (parsed === null) throw invalid();
    time = parsed;
  }
  let { year, month, day } = date;
  let { hour } = time;
  if (hour === 24 && month <= 12) {
    const inMonth = month >= 1 ? daysInMonth(year, month) : 0;
    if (day <= inMonth) {
      if (time.minute !== 0 || time.second !== 0 || time.microsecond !== 0) {
        throw new PyValueError("minute, second, and microsecond must be 0 when hour is 24");
      }
      hour = 0;
      day += 1;
      if (day > inMonth) {
        day = 1;
        month += 1;
        if (month > 12) {
          month = 1;
          year += 1;
        }
      }
    }
  }
  let iso: IsoDate;
  try {
    iso = formatDate(checkYmd(year, month, day));
  } catch {
    throw invalid();
  }
  if (hour > 23 || time.minute > 59 || time.second > 59) throw invalid();
  const offset = time.offsetMicros;
  if (offset !== null && (offset <= -MICROS_PER_DAY || offset >= MICROS_PER_DAY)) {
    throw invalid();
  }
  const local = utcInstant(iso, hour, time.minute, time.second, time.microsecond);
  return offset === null ? local : instantFromLocal(local, offset);
}

/**
 * `validation.parse_moment`: a text (`2026-10-03`, `2026-10-03T08:00:00Z`, a naive timestamp = UTC)
 * or an instant as an aware UTC instant; null when it is neither a date nor a timestamp.
 */
export function parseMoment(value: unknown): Instant | null {
  if (typeof value === "bigint") return value;
  if (typeof value !== "string") return null;
  let text = pyStrip(value);
  if (text.endsWith("Z")) text = `${text.slice(0, -1)}+00:00`;
  try {
    if (Array.from(text).length > 10) return datetimeFromIsoformat(text);
    return utcInstant(fromIsoFormat(text));
  } catch (error) {
    if (error instanceof PyValueError) return null;
    throw error;
  }
}
