/**
 * Python `str` behaviour the privacy layer needs beyond `@cashu/domain` (which has `pyCasefold`,
 * `pyLen`, `pyStrip` and the regex building blocks): `isdigit()`, `int()` of a digit string and
 * `str()` of the values a labelled leaf can hold. Tables generated from Python 3.14 (Unicode 16.0, as
 * Node's ICU); `privacy.vectors.test.ts` re-checks them.
 */

import { type DateTime, Decimal, floatRepr, formatDateTime, unicodeDecimal } from "@cashu/domain";

/** Inclusive ranges of code points that are Python `isdigit()` but not decimal digits (`\p{Nd}`). */
const DIGIT_EXTRA: readonly (readonly [number, number])[] = [
  [0xb2, 0xb3],
  [0xb9, 0xb9],
  [0x1369, 0x1371],
  [0x19da, 0x19da],
  [0x2070, 0x2070],
  [0x2074, 0x2079],
  [0x2080, 0x2089],
  [0x2460, 0x2468],
  [0x2474, 0x247c],
  [0x2488, 0x2490],
  [0x24ea, 0x24ea],
  [0x24f5, 0x24fd],
  [0x24ff, 0x24ff],
  [0x2776, 0x277e],
  [0x2780, 0x2788],
  [0x278a, 0x2792],
  [0x10a40, 0x10a43],
  [0x10e60, 0x10e68],
  [0x11052, 0x1105a],
  [0x1f100, 0x1f10a],
];

function isDigitChar(cp: number): boolean {
  return unicodeDecimal(cp) >= 0 || DIGIT_EXTRA.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** Python `s.isdigit()` (at least one character, all of them digits). */
export function pyIsDigit(s: string): boolean {
  if (s === "") return false;
  for (const ch of s) if (!isDigitChar(ch.codePointAt(0) as number)) return false;
  return true;
}

/** Python `any(c.isdigit() for c in s)`. */
export function pyHasDigit(s: string): boolean {
  for (const ch of s) if (isDigitChar(ch.codePointAt(0) as number)) return true;
  return false;
}

/** Python `int(s)` for a run of Unicode decimal digits (what `\d+` matched). */
export function pyDigitsValue(s: string): number {
  let n = 0;
  for (const ch of s) {
    const d = unicodeDecimal(ch.codePointAt(0) as number);
    if (d < 0) throw new RangeError("not a decimal digit");
    n = n * 10 + d;
  }
  return n;
}

/** A Python `datetime` as the domain models it (naive when `offsetSeconds` is null). */
export function isDateTime(value: unknown): value is DateTime {
  return (
    typeof value === "object" &&
    value !== null &&
    "date" in value &&
    "hour" in value &&
    "minute" in value &&
    "second" in value &&
    "microsecond" in value &&
    "offsetSeconds" in value
  );
}

/**
 * Python `str(value)` for the leaf values of a labelled tree, or null for a value Python would
 * render as an object repr (the redactor refuses those: fail closed).
 */
export function pyStr(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return floatRepr(value);
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value === null) return "None";
  if (value instanceof Decimal) return value.toString();
  if (isDateTime(value)) return formatDateTime(value, " ");
  return null;
}
