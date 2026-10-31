/** Cell value parsing for CSV-like exports: locale-aware decimals and pattern-based dates. */

import { checkYmd, formatDate, type IsoDate, PyValueError } from "../../dates.js";
import { Decimal } from "../../decimal.js";
import { escapeRe, PY_END } from "../../pyRegex.js";
import { pyReprStr } from "../../pyRepr.js";
import { pyStrip } from "../../text.js";
import { InvariantError } from "../domain/index.js";
import type { TimeOfDay } from "./contract.js";

export const DECIMAL_SEPARATORS: readonly string[] = [".", ","];
export const THOUSANDS_SEPARATORS: readonly string[] = ["", " ", ".", ",", "'"];

/** Python `re.compile("[   ]")`: a space thousands separator also accepts no-break spaces. */
const SPACES = /[   ]/gu;
const PLAIN_NUMBER = new RegExp(`^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)${PY_END}`, "u");

/**
 * Parses locale-formatted decimal numbers such as `1 234,56`, `1.234,56` or `-1,234.56`.
 *
 * `decimalSeparator` is `.` or `,`; `thousandsSeparator` is empty (none) or one of `" "`, `.`, `,`, `'`
 * and differs from the decimal separator. A space thousands separator also accepts no-break spaces
 * (U+00A0, U+202F).
 */
export interface DecimalFormat {
  readonly decimalSeparator: string;
  readonly thousandsSeparator: string;
}

/** `DecimalFormat(...)`: throws `InvariantError` for a separator it does not support. */
export function decimalFormat(
  decimalSeparator = ".",
  thousandsSeparator = "",
): Readonly<DecimalFormat> {
  if (!DECIMAL_SEPARATORS.includes(decimalSeparator)) {
    throw new InvariantError(`decimal_separator must be one of ${DECIMAL_SEPARATORS.join(", ")}`);
  }
  if (!THOUSANDS_SEPARATORS.includes(thousandsSeparator)) {
    throw new InvariantError(
      `thousands_separator must be one of ${THOUSANDS_SEPARATORS.map((s) => JSON.stringify(s)).join(", ")}`,
    );
  }
  if (thousandsSeparator === decimalSeparator) {
    throw new InvariantError("thousands_separator must differ from decimal_separator");
  }
  return Object.freeze({ decimalSeparator, thousandsSeparator });
}

/** `value` is null for a blank cell; `message` is Python's `ValueError` text. */
export type DecimalParse =
  | { readonly ok: true; readonly value: Decimal | null }
  | { readonly ok: false; readonly message: string };

/**
 * `DecimalFormat.parse`: accepts a leading `+` / `-` / U+2212 minus, a trailing minus (`12,50-`) and
 * accounting parentheses (`(12,50)`); a blank cell is `value: null`, anything that is not a number
 * here is `ok: false`.
 */
export function parseDecimal(format: DecimalFormat, raw: string): DecimalParse {
  let text = pyStrip(raw);
  if (text === "") return { ok: true, value: null };
  let negative = false;
  if (text.startsWith("(") && text.endsWith(")")) {
    negative = true;
    text = pyStrip(text.slice(1, -1));
  }
  text = text.replaceAll("−", "-");
  if (text.endsWith("-") && !text.startsWith("-")) {
    negative = !negative;
    text = pyStrip(text.slice(0, -1));
  }
  if (format.thousandsSeparator === " ") text = text.replace(SPACES, "");
  else if (format.thousandsSeparator !== "") text = text.replaceAll(format.thousandsSeparator, "");
  if (format.decimalSeparator !== ".") {
    if (text.includes(".")) {
      return {
        ok: false,
        message: `Unexpected "." in a number with decimal "${format.decimalSeparator}": ${pyReprStr(raw)}`,
      };
    }
    text = text.replaceAll(format.decimalSeparator, ".");
  }
  if (!PLAIN_NUMBER.test(text)) return { ok: false, message: `Not a number: ${pyReprStr(raw)}` };
  const value = Decimal.parse(text.endsWith(".") ? text.slice(0, -1) : text);
  return { ok: true, value: negative ? value.neg() : value };
}

// Longest first, so `MM` wins over `M`.
const TOKENS: readonly string[] = ["yyyy", "MM", "M", "dd", "d", "HH", "H", "mm", "ss"];
const TOKEN_REGEX: Readonly<Record<string, string>> = {
  yyyy: "([0-9]{4})",
  MM: "([0-9]{2})",
  M: "([0-9]{1,2})",
  dd: "([0-9]{2})",
  d: "([0-9]{1,2})",
  HH: "([0-9]{2})",
  H: "([0-9]{1,2})",
  mm: "([0-9]{2})",
  ss: "([0-9]{2})",
};
const TRAILING_TIME = /^([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?/u;

/**
 * A date pattern like `dd.MM.yyyy` or `yyyy-MM-dd HH:mm:ss`.
 *
 * Tokens: `yyyy` (4-digit year), `MM` / `M` (month), `dd` / `d` (day), `HH` / `H` (hour), `mm` (minute),
 * `ss` (second); every other character is a literal. The date is the calendar date as written; the
 * time of day (from the time tokens, or from extra `HH:mm[:ss]` text after the pattern separated by a
 * space or `T`) is only kept as a same-day sort key.
 */
export interface DatePattern {
  readonly pattern: string;
  /** Tokens in the order of the pattern's capture groups. */
  readonly groups: readonly string[];
  readonly regex: RegExp;
}

/** A date with the time of day when the cell carries a valid one. */
export interface DatedTime {
  readonly date: IsoDate;
  readonly time: TimeOfDay | null;
}

/** `DatePattern(...)`: throws `InvariantError` unless the pattern has a year, a month and a day token. */
export function datePattern(pattern: string): DatePattern {
  const parts = ["^"];
  const groups: string[] = [];
  const chars = Array.from(pattern);
  let i = 0;
  while (i < chars.length) {
    const rest = chars.slice(i).join("");
    const token = TOKENS.find((t) => rest.startsWith(t));
    if (token === undefined) {
      parts.push(escapeRe(chars[i] as string));
      i += 1;
      continue;
    }
    parts.push(TOKEN_REGEX[token] as string);
    groups.push(token);
    i += token.length;
  }
  parts.push("(?:[ T](.*))?$");
  const hasYear = groups.includes("yyyy");
  const hasMonth = groups.includes("MM") || groups.includes("M");
  const hasDay = groups.includes("dd") || groups.includes("d");
  if (!(hasYear && hasMonth && hasDay)) {
    throw new InvariantError(
      `A date pattern needs yyyy, MM (or M) and dd (or d): ${pyReprStr(pattern)}`,
    );
  }
  return Object.freeze({ pattern, groups, regex: new RegExp(parts.join(""), "su") });
}

function timeOfDay(
  hour: number | undefined,
  minute: number | undefined,
  second: number | undefined,
): TimeOfDay | null {
  if (hour === undefined || hour > 23 || (minute ?? 0) > 59 || (second ?? 0) > 59) return null;
  return Object.freeze({ hour, minute: minute ?? 0, second: second ?? 0 });
}

/**
 * `DatePattern.try_parse_datetime`: the date in `raw` and its time of day when the cell carries a valid
 * one, or null when `raw` does not match this pattern or is not a real date.
 */
export function tryParseDatetime(pattern: DatePattern, raw: string): DatedTime | null {
  const match = pattern.regex.exec(pyStrip(raw));
  if (match === null) return null;
  const values = new Map<string, number>();
  pattern.groups.forEach((token, index) => {
    values.set(token.charAt(0), Number(match[index + 1]));
  });
  let date: IsoDate;
  try {
    date = formatDate(
      checkYmd(values.get("y") as number, values.get("M") as number, values.get("d") as number),
    );
  } catch (error) {
    if (error instanceof PyValueError) return null;
    throw error;
  }
  let hour = values.get("H");
  let minute = values.get("m");
  let second = values.get("s");
  if (hour === undefined) {
    const trailing = TRAILING_TIME.exec(match[pattern.groups.length + 1] ?? "");
    if (trailing !== null) {
      hour = Number(trailing[1]);
      minute = Number(trailing[2]);
      second = trailing[3] ? Number(trailing[3]) : undefined;
    }
  }
  return { date, time: timeOfDay(hour, minute, second) };
}

/** `DatePattern.try_parse`: the date in `raw`, or null. */
export function tryParseDate(pattern: DatePattern, raw: string): IsoDate | null {
  return tryParseDatetime(pattern, raw)?.date ?? null;
}

/** `value` is null for a blank cell; `message` is Python's `ValueError` text. */
export type PatternParse =
  | { readonly ok: true; readonly value: DatedTime | null }
  | { readonly ok: false; readonly message: string };

/**
 * `parse_datetime_with_patterns`: `raw` parsed with the first matching pattern, with the time of day
 * when the cell has one; a blank cell is `value: null`, no matching pattern is `ok: false`.
 */
export function parseDatetimeWithPatterns(
  raw: string,
  patterns: readonly DatePattern[],
): PatternParse {
  const text = pyStrip(raw);
  if (text === "") return { ok: true, value: null };
  for (const pattern of patterns) {
    const parsed = tryParseDatetime(pattern, text);
    if (parsed !== null) return { ok: true, value: parsed };
  }
  return {
    ok: false,
    message: `Date does not match ${patterns.map((p) => p.pattern).join(" / ")}`,
  };
}

/** `value` is null for a blank cell. */
export type DateParse =
  | { readonly ok: true; readonly value: IsoDate | null }
  | { readonly ok: false; readonly message: string };

/** `parse_date_with_patterns`: like `parseDatetimeWithPatterns`, the date only. */
export function parseDateWithPatterns(raw: string, patterns: readonly DatePattern[]): DateParse {
  const parsed = parseDatetimeWithPatterns(raw, patterns);
  return parsed.ok ? { ok: true, value: parsed.value?.date ?? null } : parsed;
}
