/**
 * The value coercers of `canonical.py` (lines 149-234: `_iso_date`, `_amount`, `_currency`, `_iban`,
 * `_blank_none`) plus pydantic's string checks, each returning the value or a pydantic-style error
 * (`type`, `msg`, `ctx`) that `validate.ts` places and `report.ts` maps to an issue. Messages are
 * Python's, value-free.
 */

import { fromIsoFormat, type IsoDate, PyValueError } from "../../../dates.js";
import { Decimal } from "../../../decimal.js";
import { normalizeIban } from "../../../iban.js";
import type { JsonValue } from "../../../pyJson.js";
import { pyStrip, pyUpper } from "../../../text.js";
import { CURRENCY_RE, DATE_RE, IBAN_MAX, IBAN_MIN, NUMBER_RE } from "./constants.js";

export interface FieldError {
  readonly type: string;
  readonly msg: string;
  readonly ctx?: { readonly max_length?: number; readonly pattern?: string };
}

export type Coerced<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: FieldError };

const ok = <T>(value: T): Coerced<T> => ({ ok: true, value });
const fail = (type: string, msg: string, ctx?: FieldError["ctx"]): Coerced<never> => ({
  ok: false,
  error: ctx === undefined ? { type, msg } : { type, msg, ctx },
});

const isBlank = (v: JsonValue) => v === null || (typeof v === "string" && pyStrip(v) === "");

/** `_required`: null or a blank string is a custom `missing` error. */
const REQUIRED = fail("missing", "is required");

export function isoDate(v: JsonValue): Coerced<IsoDate> {
  if (isBlank(v)) return REQUIRED;
  if (typeof v !== "string") return fail("date_format", "must be a date string YYYY-MM-DD");
  const text = pyStrip(v);
  if (!DATE_RE.test(text)) return fail("date_format", "is not a date in YYYY-MM-DD format");
  try {
    return ok(fromIsoFormat(text));
  } catch (error) {
    if (error instanceof PyValueError) return fail("date_format", "is not a real calendar date");
    throw error;
  }
}

export function optionalDate(v: JsonValue): Coerced<IsoDate | null> {
  return isBlank(v) ? ok(null) : isoDate(v);
}

export function amount(v: JsonValue): Coerced<Decimal> {
  if (isBlank(v)) return REQUIRED;
  if (typeof v === "boolean") return fail("decimal_format", "must be a decimal number");
  if (v instanceof Decimal) return ok(v); // JSON numbers with a fraction / exponent: always finite here
  if (typeof v === "bigint") return ok(Decimal.fromInt(v));
  if (typeof v === "string") {
    const text = pyStrip(v);
    if (NUMBER_RE.test(text)) return ok(Decimal.parse(text));
    return fail(
      "decimal_format",
      'is not a decimal number (use "." as the decimal separator, no thousands separators)',
    );
  }
  return fail("decimal_format", "must be a decimal number");
}

export function optionalAmount(v: JsonValue): Coerced<Decimal | null> {
  return isBlank(v) ? ok(null) : amount(v);
}

export function currency(v: JsonValue): Coerced<string> {
  if (isBlank(v)) return REQUIRED;
  if (typeof v !== "string" || !CURRENCY_RE.test(pyStrip(v))) {
    return fail("currency_format", "must be a 3-letter ISO 4217 code");
  }
  return ok(pyUpper(pyStrip(v)));
}

/** `_blank_none`: a string stripped (blank -> null); anything else as it is. */
function blankNone(v: JsonValue): JsonValue {
  return typeof v === "string" ? pyStrip(v) || null : v;
}

export function iban(v: JsonValue): Coerced<string | null> {
  const value = blankNone(v);
  if (value === null) return ok(null);
  if (typeof value !== "string") return fail("iban_format", "must be a string");
  const canon = normalizeIban(value);
  if (canon.length < IBAN_MIN || canon.length > IBAN_MAX) {
    return fail("iban_format", "is not an account number (IBAN or NRB)");
  }
  return ok(canon);
}

/** `Annotated[str(max_length) | None, BeforeValidator(_blank_none)]`. */
export function text(maxLength: number): (v: JsonValue) => Coerced<string | null> {
  return (v) => {
    const value = blankNone(v);
    if (value === null) return ok(null);
    if (typeof value !== "string") return fail("string_type", "Input should be a valid string");
    if (Array.from(value).length > maxLength) {
      return fail("string_too_long", `String should have at most ${maxLength} characters`, {
        max_length: maxLength,
      });
    }
    return ok(value);
  };
}

/** `Annotated[str(pattern) | None, BeforeValidator(_blank_none)]` (institution and source ids). */
export function patterned(pattern: string): (v: JsonValue) => Coerced<string | null> {
  const re = new RegExp(pattern, "u");
  return (v) => {
    const value = blankNone(v);
    if (value === null) return ok(null);
    if (typeof value !== "string") return fail("string_type", "Input should be a valid string");
    if (!re.test(value))
      return fail("string_pattern_mismatch", `String should match pattern '${pattern}'`, {
        pattern,
      });
    return ok(value);
  };
}
