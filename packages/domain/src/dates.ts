/**
 * Calendar dates and timestamps with Python `datetime` / `dateutil.relativedelta` semantics.
 *
 * A calendar date is its ISO text `YYYY-MM-DD` (what Python's `date.isoformat()` writes and SQLite
 * stores); arithmetic goes through Python's proleptic Gregorian ordinal (`date.toordinal()`).
 * Errors mirror Python's exception classes: `PyValueError` (bad field, year out of 1..9999 after
 * month arithmetic, malformed text) and `PyOverflowError` (`date + timedelta` out of range).
 */

export type IsoDate = string;

export class PyValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export class PyOverflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OverflowError";
  }
}

export interface Ymd {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const MINYEAR = 1;
export const MAXYEAR = 9999;
const MAX_ORDINAL = 3652059; // date(9999, 12, 31).toordinal()
const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DAYS_BEFORE_MONTH = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Python `calendar.monthrange(year, month)[1]`. */
export function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeap(year) ? 29 : (DAYS_IN_MONTH[month] as number);
}

function daysBeforeYear(year: number): number {
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/** Python `date(year, month, day)` validation (ValueError on a bad field). */
export function checkYmd(year: number, month: number, day: number): Ymd {
  if (!(MINYEAR <= year && year <= MAXYEAR)) {
    throw new PyValueError(`year must be in ${MINYEAR}..${MAXYEAR}, not ${year}`);
  }
  if (!(1 <= month && month <= 12)) throw new PyValueError(`month must be in 1..12, not ${month}`);
  const dim = daysInMonth(year, month);
  if (!(1 <= day && day <= dim))
    throw new PyValueError(
      `day ${day} must be in range 1..${dim} for month ${month} in year ${year}`,
    );
  return { year, month, day };
}

/** `YYYY-MM-DD` of a valid date. */
export function formatDate(ymd: Ymd): IsoDate {
  const { year, month, day } = ymd;
  // The common shapes without padStart (called once per generated or shifted date).
  const y = year >= 1000 && year <= 9999 ? String(year) : pad(year, 4);
  return `${y}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}

function invalidIso(text: string): PyValueError {
  return new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
}

/**
 * Strict `YYYY-MM-DD` to `year * 10000 + month * 100 + day`, validated like `checkYmd`. Reads the char
 * codes directly (same strictness as `^\d{4}-\d{2}-\d{2}$`: ASCII digits, nothing after) and
 * allocates nothing: dates are parsed once per bar and per shifted day in the series code.
 */
function packDate(text: IsoDate): number {
  if (text.length !== 10 || text.charCodeAt(4) !== 45 || text.charCodeAt(7) !== 45) {
    throw invalidIso(text);
  }
  let year = 0;
  let month = 0;
  let day = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) throw invalidIso(text);
    if (i < 4) year = year * 10 + digit;
    else if (i < 7) month = month * 10 + digit;
    else day = day * 10 + digit;
  }
  if (year < MINYEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    checkYmd(year, month, day); // throws the field error
  }
  return year * 10000 + month * 100 + day;
}

/** Strict `YYYY-MM-DD` (the stored form) to its fields; ValueError otherwise. */
export function parseDate(text: IsoDate): Ymd {
  const packed = packDate(text);
  return {
    year: Math.floor(packed / 10000),
    month: Math.floor(packed / 100) % 100,
    day: packed % 100,
  };
}

function ordinalOf(year: number, month: number, day: number): number {
  return (
    daysBeforeYear(year) +
    (DAYS_BEFORE_MONTH[month] as number) +
    (month > 2 && isLeap(year) ? 1 : 0) +
    day
  );
}

/** Python `date.toordinal()` (0001-01-01 is 1). */
export function toOrdinal(date: IsoDate | Ymd): number {
  if (typeof date === "string") {
    const packed = packDate(date);
    return ordinalOf(Math.floor(packed / 10000), Math.floor(packed / 100) % 100, packed % 100);
  }
  return ordinalOf(date.year, date.month, date.day);
}

/** Python `date.fromordinal(n)`. */
export function fromOrdinal(n: number): IsoDate {
  if (!(1 <= n && n <= MAX_ORDINAL)) throw new PyValueError(`ordinal must be >= 1, got ${n}`);
  // _ord2ymd of CPython
  let rest = n - 1;
  const n400 = Math.floor(rest / 146097);
  rest %= 146097;
  let year = n400 * 400 + 1;
  const n100 = Math.floor(rest / 36524);
  rest %= 36524;
  const n4 = Math.floor(rest / 1461);
  rest %= 1461;
  const n1 = Math.floor(rest / 365);
  rest %= 365;
  year += n100 * 100 + n4 * 4 + n1;
  if (n1 === 4 || n100 === 4) return formatDate({ year: year - 1, month: 12, day: 31 });
  const leap = n1 === 3 && (n4 !== 24 || n100 === 3);
  let month = (rest + 50) >> 5;
  let preceding = (DAYS_BEFORE_MONTH[month] as number) + (month > 2 && leap ? 1 : 0);
  if (preceding > rest) {
    month -= 1;
    preceding -= month === 2 && leap ? 29 : (DAYS_IN_MONTH[month] as number);
  }
  return formatDate({ year, month, day: rest - preceding + 1 });
}

/** Python `date + timedelta(days=n)` (OverflowError out of range). */
export function addDays(date: IsoDate, days: number): IsoDate {
  const n = toOrdinal(date) + days;
  if (!(1 <= n && n <= MAX_ORDINAL)) throw new PyOverflowError("date value out of range");
  return fromOrdinal(n);
}

/** Python `(end - start).days`. */
export function daysBetween(start: IsoDate, end: IsoDate): number {
  return toOrdinal(end) - toOrdinal(start);
}

/**
 * Python `date + relativedelta(months=n)`: the same day `n` months later, clamped to the last day of
 * the target month (`2024-01-31 + 1 month = 2024-02-29`). ValueError when the year leaves 1..9999.
 * Also `performance/report.py:months_back(d, m)` = `addMonths(d, -m)`.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const { year, month, day } = parseDate(date);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12 + 1;
  if (!(MINYEAR <= y && y <= MAXYEAR)) throw new PyValueError(`year ${y} is out of range`);
  return formatDate({ year: y, month: m, day: Math.min(day, daysInMonth(y, m)) });
}

/** `performance/report.py:months_back` / `service/views.py:_months_before`. */
export function monthsBack(date: IsoDate, months: number): IsoDate {
  return addMonths(date, -months);
}

/** Last day of the date's month. */
export function monthEnd(date: IsoDate): IsoDate {
  const { year, month } = parseDate(date);
  return formatDate({ year, month, day: daysInMonth(year, month) });
}

/** Python `date.weekday()`: Monday 0 .. Sunday 6. */
export function weekday(date: IsoDate): number {
  return (toOrdinal(date) + 6) % 7;
}

/** Python `date.isoweekday()`: Monday 1 .. Sunday 7. */
export function isoWeekday(date: IsoDate): number {
  return weekday(date) + 1;
}

function isoWeek1Monday(year: number): number {
  const firstDay = daysBeforeYear(year) + 1;
  const firstWeekday = (firstDay + 6) % 7;
  let monday = firstDay - firstWeekday;
  if (firstWeekday > 3) monday += 7;
  return monday;
}

/** Python `date.isocalendar()` as `[isoYear, week, isoWeekday]`. */
export function isoCalendar(date: IsoDate): [number, number, number] {
  const { year } = parseDate(date);
  const ord = toOrdinal(date);
  let isoYear = year;
  let week1 = isoWeek1Monday(isoYear);
  let today = ord - week1;
  let week = Math.floor(today / 7);
  let day = today % 7;
  if (today < 0) {
    isoYear -= 1;
    week1 = isoWeek1Monday(isoYear);
    today = ord - week1;
    week = Math.floor(today / 7);
    day = today % 7;
  } else if (week >= 52 && ord >= isoWeek1Monday(isoYear + 1)) {
    isoYear += 1;
    week = 0;
  }
  return [isoYear, week + 1, day + 1];
}

/** `research/scoring.py:iso_week`: `2026-W40`. */
export function isoWeekLabel(date: IsoDate): string {
  const [year, week] = isoCalendar(date);
  return `${year}-W${pad(week, 2)}`;
}

/** `research/scoring.py:week_start`: Monday of the date's ISO week. */
export function weekStart(date: IsoDate): IsoDate {
  return addDays(date, -(isoWeekday(date) - 1));
}

function isoToOrdinal(year: number, week: number, day: number): number {
  if (!(MINYEAR <= year && year <= MAXYEAR))
    throw new PyValueError(`Year is out of range: ${year}`);
  if (!(0 < week && week < 53)) {
    let outOfRange = true;
    if (week === 53) {
      const firstWeekday = daysBeforeYear(year) % 7; // (ordinal of Jan 1 + 6) % 7
      if (firstWeekday === 3 || (firstWeekday === 2 && isLeap(year))) outOfRange = false;
    }
    if (outOfRange) throw new PyValueError(`Invalid week: ${week}`);
  }
  if (!(0 < day && day < 8)) throw new PyValueError(`Invalid weekday: ${day} (range is [1, 7])`);
  return isoWeek1Monday(year) + (week - 1) * 7 + (day - 1);
}

/** Python `date.fromisocalendar(year, week, day)`. */
export function fromIsoCalendar(year: number, week: number, day: number): IsoDate {
  const ord = isoToOrdinal(year, week, day);
  if (ord > MAX_ORDINAL) throw new PyValueError(`year ${MAXYEAR + 1} is out of range`);
  return fromOrdinal(ord);
}

function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Python `date.fromisoformat(text)` (the C implementation of 3.11+): `YYYY-MM-DD`, `YYYYMMDD`,
 * `YYYY-Www[-D]`, `YYYYWww[D]`, including its quirks (`"20260101xx"` is accepted: only the UTF-8
 * length 7, 8 or 10 is checked and trailing characters after a complete date are ignored).
 */
export function fromIsoFormat(text: string): IsoDate {
  const invalid = () => new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
  const len = utf8Length(text);
  if (len !== 7 && len !== 8 && len !== 10) throw invalid();
  let p = 0;
  const digits = (n: number): number => {
    let value = 0;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(p + i);
      if (!(c >= 48 && c <= 57)) throw invalid();
      value = value * 10 + (c - 48);
    }
    p += n;
    return value;
  };
  const year = digits(4);
  const sep = text[p] === "-";
  if (sep) p++;
  if (text[p] === "W") {
    p++;
    const week = digits(2);
    let day = 1;
    if (p < len) {
      if (sep && text[p++] !== "-") throw invalid();
      day = digits(1);
    }
    let ord: number;
    try {
      ord = isoToOrdinal(year, week, day);
    } catch {
      throw invalid();
    }
    if (ord > MAX_ORDINAL) throw new PyValueError(`year ${MAXYEAR + 1} is out of range`);
    return fromOrdinal(ord);
  }
  const month = digits(2);
  if (sep && text[p++] !== "-") throw invalid();
  const day = digits(2);
  return formatDate(checkYmd(year, month, day));
}

// ------------------------------------------------------------------ timestamps

/** A Python datetime: naive (`offsetSeconds` null = UTC by the app's convention) or aware. */
export interface DateTime {
  readonly date: IsoDate;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly microsecond: number;
  readonly offsetSeconds: number | null;
}

/**
 * Python `datetime.fromisoformat` for the forms Python and SQLite write: `YYYY-MM-DD`, a `T` or space,
 * `HH:MM[:SS[.f...]]` (fraction truncated to microseconds), optionally `Z` or `+HH:MM[:SS[.ffffff]]`
 * (`+HHMM`, `+HH` too). Other forms Python accepts (week dates, compact times, any separator) throw.
 */
export function parseDateTime(text: string): DateTime {
  const m =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.(\d{6}))?)?)?)?$/.exec(
      text,
    );
  if (!m) throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
  const date = formatDate(parseDate(m[1] as string));
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  const second = m[4] === undefined ? 0 : Number(m[4]);
  const microsecond = m[5] === undefined ? 0 : Number(m[5].slice(0, 6).padEnd(6, "0"));
  if (hour > 23 || minute > 59 || second > 59) {
    throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
  }
  let offsetSeconds: number | null = null;
  const tz = m[6];
  if (tz === "Z") offsetSeconds = 0;
  else if (tz !== undefined) {
    if (m[7] !== undefined && m[7] !== "000000") {
      throw new PyValueError("sub-second UTC offsets are not supported");
    }
    const parts = tz
      .slice(1)
      .replace(/\.\d+$/, "")
      .replaceAll(":", "");
    const hh = Number(parts.slice(0, 2));
    const mm = parts.length >= 4 ? Number(parts.slice(2, 4)) : 0;
    const ss = parts.length >= 6 ? Number(parts.slice(4, 6)) : 0;
    if (mm > 59 || ss > 59 || hh > 23)
      throw new PyValueError(`Invalid isoformat string: ${JSON.stringify(text)}`);
    offsetSeconds = (tz[0] === "-" ? -1 : 1) * (hh * 3600 + mm * 60 + ss);
  }
  return { date, hour, minute, second, microsecond, offsetSeconds };
}

function formatOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const abs = Math.abs(offsetSeconds);
  const hh = Math.floor(abs / 3600);
  const mm = Math.floor((abs % 3600) / 60);
  const ss = abs % 60;
  return `${sign}${pad(hh, 2)}:${pad(mm, 2)}${ss ? `:${pad(ss, 2)}` : ""}`;
}

/** Python `datetime.isoformat(sep)` (microseconds only when non-zero). */
export function formatDateTime(value: DateTime, sep = "T"): string {
  const time = `${pad(value.hour, 2)}:${pad(value.minute, 2)}:${pad(value.second, 2)}`;
  const micro = value.microsecond ? `.${pad(value.microsecond, 6)}` : "";
  const offset = value.offsetSeconds === null ? "" : formatOffset(value.offsetSeconds);
  return `${value.date}${sep}${time}${micro}${offset}`;
}

/**
 * Python `dt + timedelta(microseconds=micros)`: wall-clock arithmetic, the offset (or naivety) kept.
 * `micros` must be an integer.
 */
export function addMicroseconds(value: DateTime, micros: number): DateTime {
  const DAY = 86_400_000_000;
  const total =
    ((value.hour * 60 + value.minute) * 60 + value.second) * 1_000_000 + value.microsecond + micros;
  const dayShift = Math.floor(total / DAY);
  const rest = total - dayShift * DAY;
  const seconds = Math.floor(rest / 1_000_000);
  return {
    date: dayShift === 0 ? value.date : addDays(value.date, dayShift),
    hour: Math.floor(seconds / 3600),
    minute: Math.floor((seconds % 3600) / 60),
    second: seconds % 60,
    microsecond: rest % 1_000_000,
    offsetSeconds: value.offsetSeconds,
  };
}

/** Python `dt.astimezone(UTC)`; a naive value is taken as UTC (the SQLite convention). */
export function toUtc(value: DateTime): DateTime {
  const offset = value.offsetSeconds ?? 0;
  const seconds = value.hour * 3600 + value.minute * 60 + value.second - offset;
  const dayShift = Math.floor(seconds / 86400);
  const rest = seconds - dayShift * 86400;
  return {
    date: dayShift === 0 ? value.date : addDays(value.date, dayShift),
    hour: Math.floor(rest / 3600),
    minute: Math.floor((rest % 3600) / 60),
    second: rest % 60,
    microsecond: value.microsecond,
    offsetSeconds: 0,
  };
}

/** `core/api.py:utc_iso` for a datetime: ISO 8601 in UTC with `+00:00`, never naive. */
export function utcIso(value: DateTime | string): string {
  return formatDateTime(toUtc(typeof value === "string" ? parseDateTime(value) : value));
}

/** The naive-UTC text SQLAlchemy stores in SQLite: `YYYY-MM-DD HH:MM:SS.ffffff`. */
export function toStorage(value: DateTime | string): string {
  const utc = toUtc(typeof value === "string" ? parseDateTime(value) : value);
  return `${utc.date} ${pad(utc.hour, 2)}:${pad(utc.minute, 2)}:${pad(utc.second, 2)}.${pad(utc.microsecond, 6)}`;
}
