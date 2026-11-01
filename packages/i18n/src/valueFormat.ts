// Exact display formatting. Intl supplies locale punctuation, grouping and unit placement; Decimal
// supplies rounding and digits, so a large balance never passes through an IEEE-754 number.
import { Decimal, parseDate } from "@cashu/domain";

export interface NumberDisplayOptions {
  readonly currency?: string;
  /** A ratio (0.125 = 12.5%), not a percentage-point count. */
  readonly percent?: boolean;
  readonly fractionDigits?: number;
  readonly signed?: boolean;
}

export interface NumberDisplay {
  readonly text: string;
  /** The sign after display rounding; rounded zero has no gain/loss tone. */
  readonly sign: -1 | 0 | 1;
}

const localizedDigits = new Map<string, readonly string[]>();
function localizeFraction(fraction: string, locale: string): string {
  const formatter = numberFormat(locale, { useGrouping: false });
  if (formatter.resolvedOptions().numberingSystem === "latn") return fraction;
  let digits = localizedDigits.get(locale);
  if (!digits) {
    digits = Array.from({ length: 10 }, (_, digit) => formatter.format(digit));
    localizedDigits.set(locale, digits);
  }
  return [...fraction].map((digit) => digits[digit.charCodeAt(0) - 48]).join("");
}

const numberFormats = new Map<string, Intl.NumberFormat>();
function numberFormat(locale: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify([locale, options]);
  let format = numberFormats.get(key);
  if (!format) {
    format = new Intl.NumberFormat(locale, options);
    numberFormats.set(key, format);
  }
  return format;
}

/** Formats a Decimal with exact rounding; percent inputs are ratios. */
export function formatDecimalValue(
  value: Decimal,
  locale: string,
  options: NumberDisplayOptions = {},
): NumberDisplay {
  const style = options.currency ? "currency" : options.percent ? "percent" : "decimal";
  const base: Intl.NumberFormatOptions = {
    style,
    ...(options.currency ? { currency: options.currency } : {}),
    signDisplay: options.signed ? "exceptZero" : "auto",
  };
  const digits =
    options.fractionDigits ??
    (options.currency
      ? (numberFormat(locale, base).resolvedOptions().maximumFractionDigits ?? 2)
      : options.percent
        ? 1
        : 2);
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new RangeError("fractionDigits must be an integer from 0 to 20");
  }
  const scaled = options.percent
    ? Decimal.fromTriple(value.sign, value.digits, value.exp + 2)
    : value;
  const rounded = scaled.rescale(-digits, "ROUND_HALF_UP");
  const sign = rounded.isZero() ? 0 : rounded.sign ? -1 : 1;
  const coefficient = rounded.digits.padStart(digits + 1, "0");
  const integer = digits === 0 ? coefficient : coefficient.slice(0, -digits);
  const fraction = digits === 0 ? "" : localizeFraction(coefficient.slice(-digits), locale);
  // Currency grouping can differ from decimal grouping (for example four digits in Polish).
  const integerFormat = numberFormat(locale, {
    style: options.currency ? "currency" : "decimal",
    ...(options.currency ? { currency: options.currency } : {}),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  const grouped = integerFormat
    .formatToParts(BigInt(integer))
    .filter((p) => p.type === "integer" || p.type === "group")
    .map((p) => p.value)
    .join("");
  const format = numberFormat(locale, {
    ...base,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // Only the sign of this tiny template matters; no amount is converted to a number.
  const text = format
    .formatToParts(sign === 0 && rounded.sign && !options.signed ? -0 : sign)
    .map((p) => (p.type === "integer" ? grouped : p.type === "fraction" ? fraction : p.value))
    .join("");
  return { text, sign };
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** Calendar dates stay on their ISO day in every device timezone. */
export function formatCalendarDate(
  value: string,
  locale: string,
  style: "short" | "medium" | "long" = "medium",
): string {
  const { year, month, day } = parseDate(value);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(12, 0, 0, 0);
  const key = JSON.stringify([locale, style]);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: "UTC" });
    dateFormats.set(key, format);
  }
  return format.format(date);
}
