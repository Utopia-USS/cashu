// Genesis value decoding (S26 spec 2.3): one stored Python column value (SQLAlchemy on SQLite) to the
// canonical payload text the event schemas take. A value that does not decode is a typed failure;
// the source reader skips the row and counts `(table, reason)`. Failures never carry the value.
import {
  D,
  type DateTime,
  DecimalError,
  PyOverflowError,
  PyValueError,
  parseDate,
  parseDateTime,
  toUtc,
} from "@cashu/domain";
import { DATE_RE, DECIMAL_RE } from "../events/v1/primitives.js";
import type { SqlValue } from "../sql/driver.js";

export type DecodeFailure =
  | "bad_timestamp"
  | "bad_date"
  | "bad_decimal"
  | "bad_enum"
  | "bad_bool"
  | "bad_int"
  | "bad_text"
  | "bad_json";

export type DecodeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: DecodeFailure };

const ok = <T>(value: T): DecodeResult<T> => ({ ok: true, value });
const fail = <T>(reason: DecodeFailure): DecodeResult<T> => ({ ok: false, reason });

/** An INTEGER column (better-sqlite3 returns number, a driver with safe big ints bigint). */
export function decodeInt(v: SqlValue): DecodeResult<number> {
  if (typeof v === "number" && Number.isSafeInteger(v)) return ok(v);
  if (
    typeof v === "bigint" &&
    v >= BigInt(Number.MIN_SAFE_INTEGER) &&
    v <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return ok(Number(v));
  }
  return fail("bad_int");
}

export function decodeText(v: SqlValue): DecodeResult<string> {
  return typeof v === "string" ? ok(v) : fail("bad_text");
}

/** BOOLEAN: SQLAlchemy stores 0 / 1. */
export function decodeBool(v: SqlValue): DecodeResult<boolean> {
  const n = decodeInt(v);
  if (!n.ok || (n.value !== 0 && n.value !== 1)) return fail("bad_bool");
  return ok(n.value === 1);
}

// `YYYY-MM-DD`, a space or `T`, `HH:MM:SS`, an optional fraction of 1-6 digits, an optional `Z` or
// `+HH:MM` / `-HH:MM` offset. Every other shape (no seconds, compact offsets, 7+ fraction digits) is
// not something SQLAlchemy or the app writes and is refused rather than guessed.
const STORED_TS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * DATETIME (naive = UTC) to `YYYY-MM-DDTHH:MM:SS[.f]Z`. The stored fraction digits are kept as
 * written (events.md 4.3: genesis keeps Python's six); no fraction stays no fraction. Another offset
 * is converted to UTC (date and time shift; the fraction is unaffected by a whole-minute offset).
 */
export function decodeTimestamp(v: SqlValue): DecodeResult<string> {
  if (typeof v !== "string") return fail("bad_timestamp");
  const m = STORED_TS_RE.exec(v);
  if (m === null) return fail("bad_timestamp");
  let utc: DateTime;
  try {
    // Calendar and range validation, offset parsing: the domain port of `datetime.fromisoformat`.
    utc = toUtc(parseDateTime(v));
  } catch (e) {
    if (e instanceof PyValueError || e instanceof PyOverflowError) return fail("bad_timestamp");
    throw e;
  }
  const fraction = m[3] ?? "";
  return ok(`${utc.date}T${pad2(utc.hour)}:${pad2(utc.minute)}:${pad2(utc.second)}${fraction}Z`);
}

/** DATE: strict `YYYY-MM-DD` of a real calendar date. */
export function decodeDate(v: SqlValue): DecodeResult<string> {
  if (typeof v !== "string" || !DATE_RE.test(v)) return fail("bad_date");
  try {
    parseDate(v);
  } catch (e) {
    if (e instanceof PyValueError) return fail("bad_date");
    throw e;
  }
  return ok(v);
}

// What `str(Decimal)` writes for a finite value: plain or scientific (`1E+2`, `1.5E-7`, `0E-8`).
const STORED_DECIMAL_RE = /^-?\d+(\.\d+)?(E[+-]\d+)?$/;

/**
 * DecimalText: the stored `str(Decimal)` rewritten to plain notation with the scale kept
 * (`format(d, "f")`: `10.50` stays, `1E+2` -> `100`, `1.5E-7` -> `0.00000015`).
 */
export function decodeDecimal(v: SqlValue): DecodeResult<string> {
  if (typeof v !== "string" || !STORED_DECIMAL_RE.test(v)) return fail("bad_decimal");
  let text: string;
  try {
    text = D(v).format("f");
  } catch (e) {
    if (e instanceof DecimalError) return fail("bad_decimal");
    throw e;
  }
  return DECIMAL_RE.test(text) ? ok(text) : fail("bad_decimal");
}

/** Python `core.models.Source`, stored by NAME in an `sa.Enum` column (as `PythonDb` reads it). */
const SOURCE_BY_NAME: ReadonlyMap<string, Source> = new Map([
  ["OPEN_BANKING", "open_banking"],
  ["CSV", "csv"],
  ["MANUAL", "manual"],
  ["CONNECTOR", "connector"],
]);

export type Source = "open_banking" | "csv" | "manual" | "connector";

export function decodeSource(v: SqlValue): DecodeResult<Source> {
  const value = typeof v === "string" ? SOURCE_BY_NAME.get(v) : undefined;
  return value === undefined ? fail("bad_enum") : ok(value);
}

/** A decoded JSON column plus the number tokens `JSON.parse` cannot keep exactly (spec R-G9). */
export interface JsonValue {
  readonly value: unknown;
  /** Number tokens with a fraction or an exponent: Python floats, read back as JS numbers. */
  readonly floats: number;
  /** Integer tokens above 2^53 in magnitude: rounded by `JSON.parse`. */
  readonly bigInts: number;
}

const TWO_53 = 2n ** 53n;

/** Counts float and big-int number tokens outside strings (the text already parsed as JSON). */
function scanNumbers(text: string): { floats: number; bigInts: number } {
  let floats = 0;
  let bigInts = 0;
  const token = /"(?:[^"\\]|\\.)*"|-?\d+(\.\d+)?([eE][+-]?\d+)?/g;
  for (let m = token.exec(text); m !== null; m = token.exec(text)) {
    const t = m[0];
    if (t.startsWith('"')) continue;
    if (m[1] !== undefined || m[2] !== undefined) floats++;
    else if ((t.startsWith("-") ? -BigInt(t) : BigInt(t)) > TWO_53) bigInts++;
  }
  return { floats, bigInts };
}

/**
 * A SQLAlchemy JSON column. Strict `JSON.parse` (Python's `NaN` / `Infinity` literals are not JSON
 * and fail `bad_json`). SQL NULL and the JSON text `null` (how the ORM stores None) are null for a
 * nullable column, and the model's default (`{}` / `[]`) for a NOT NULL one.
 */
export function decodeJson(
  v: SqlValue,
  shape: { readonly nullable: boolean; readonly empty: "object" | "list" },
): DecodeResult<JsonValue> {
  const empty = (): JsonValue => ({
    value: shape.nullable ? null : shape.empty === "object" ? {} : [],
    floats: 0,
    bigInts: 0,
  });
  if (v === null) return ok(empty());
  if (typeof v !== "string") return fail("bad_json");
  let value: unknown;
  try {
    value = JSON.parse(v);
  } catch {
    return fail("bad_json");
  }
  if (value === null) return ok(empty());
  return ok({ value, ...scanNumbers(v) });
}
