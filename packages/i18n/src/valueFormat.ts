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
  const grouped = groupedInteger(integerFormat, integer);
  const format = numberFormat(locale, {
    ...base,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  // Only the sign of this tiny template matters; no amount is converted to a number.
  const template = sign === 0 && rounded.sign && !options.signed ? -0 : sign;
  const text = hasNumberParts()
    ? format
        .formatToParts(template)
        .map((p) => (p.type === "integer" ? grouped : p.type === "fraction" ? fraction : p.value))
        .join("")
    : fillNumberTemplate(
        // A percent template needs the ratio of one percent to keep a single integer digit; Hermes
        // also ignores `signDisplay: "exceptZero"`, so the plus sign is added by hand.
        withPlus(
          format.format(options.percent ? template / 100 : template),
          options.signed && sign > 0,
        ),
        grouped,
        fraction,
        digits,
      );
  return { text, sign };
}

// Hermes on iOS has no `Intl.NumberFormat.prototype.formatToParts` (DateTimeFormat has it), so the
// phone builds the same strings from `format()` output: the grouped integer is the digit run of the
// formatted integer (locale grouping rules included), and the template of a one-digit number is filled
// by position. Tests force this path with `setNumberPartsForTests`.
let numberParts: boolean | null = null;
function hasNumberParts(): boolean {
  if (numberParts === null) {
    numberParts = typeof Intl.NumberFormat.prototype.formatToParts === "function";
  }
  return numberParts;
}
/** Test hook: pretend `formatToParts` is missing (null restores detection). */
export function setNumberPartsForTests(available: boolean | null): void {
  numberParts = available;
}

const SAFE_INTEGER_DIGITS = 15;

/** The integer digits with the locale's group separators, from a currency or decimal format. */
function groupedInteger(format: Intl.NumberFormat, integer: string): string {
  if (hasNumberParts()) {
    return format
      .formatToParts(BigInt(integer))
      .filter((p) => p.type === "integer" || p.type === "group")
      .map((p) => p.value)
      .join("");
  }
  if (integer.length > SAFE_INTEGER_DIGITS) {
    // Hermes cannot format a BigInt: group by hand with the separator the locale puts after the
    // first digit of a seven-digit sample (empty when the locale does not group).
    const sample = digitRun(format.format(1234567));
    const separator = sample.slice(1, sample.indexOf("234") < 0 ? 1 : sample.indexOf("234"));
    return integer.replace(/\B(?=(\d{3})+(?!\d))/gu, separator);
  }
  return digitRun(format.format(Number(integer))) || integer;
}

/** Prefixes "+" when a signed positive template came back without one (Hermes). */
function withPlus(template: string, wanted: boolean | undefined): string {
  return wanted && !template.includes("+") ? `+${template}` : template;
}

/** The slice from the first to the last digit of a formatted number (integer digits and group marks). */
function digitRun(formatted: string): string {
  const first = formatted.search(/\p{Nd}/u);
  const last = formatted.search(/\p{Nd}(?!.*\p{Nd})/su);
  return first < 0 ? "" : formatted.slice(first, last + 1);
}

/**
 * Fills the one-digit template (`"-PLN 1.00"`, `"1,00 zł"`, `"0.0%"`) with the real integer and
 * fraction: the first digit is the integer slot, the `digits` digits after the decimal separator are
 * the fraction slot; everything else (sign, currency, separators) stays as the locale wrote it.
 */
export function fillNumberTemplate(
  template: string,
  grouped: string,
  fraction: string,
  digits: number,
): string {
  const integerAt = template.search(/\p{Nd}/u);
  if (integerAt < 0) return template;
  const afterInteger = integerAt + 1;
  if (digits === 0) return template.slice(0, integerAt) + grouped + template.slice(afterInteger);
  const rest = template.slice(afterInteger);
  const fractionAt = rest.search(/\p{Nd}/u);
  if (fractionAt < 0) return template.slice(0, integerAt) + grouped + rest;
  const separator = rest.slice(0, fractionAt);
  const tail = rest.slice(fractionAt + digits);
  return template.slice(0, integerAt) + grouped + separator + fraction + tail;
}

/** The UTC noon of an ISO calendar date, so formatting in UTC keeps its day in every device timezone. */
function calendarNoon(value: string): Date {
  const { year, month, day } = parseDate(value);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(12, 0, 0, 0);
  return date;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** Calendar dates stay on their ISO day in every device timezone. */
export function formatCalendarDate(
  value: string,
  locale: string,
  style: "short" | "medium" | "long" = "medium",
): string {
  const date = calendarNoon(value);
  const key = JSON.stringify([locale, style]);
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: "UTC" });
    dateFormats.set(key, format);
  }
  return format.format(date);
}

const dayFormats = new Map<string, readonly [Intl.DateTimeFormat, Intl.DateTimeFormat]>();
/** The day of the month and the short weekday of an ISO calendar date (the date column of a list:
 * "12" over "Thu"), on its ISO day in every device timezone. */
export function formatCalendarDay(
  value: string,
  locale: string,
): { readonly day: string; readonly weekday: string } {
  let formats = dayFormats.get(locale);
  if (!formats) {
    formats = [
      new Intl.DateTimeFormat(locale, { day: "numeric", timeZone: "UTC" }),
      new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }),
    ];
    dayFormats.set(locale, formats);
  }
  const date = calendarNoon(value);
  return { day: formats[0].format(date), weekday: formats[1].format(date) };
}

const clockFormats = new Map<string, Intl.DateTimeFormat>();
function clockFormat(locale: string, timeZone: string | undefined, weekday: boolean) {
  const key = JSON.stringify([locale, timeZone ?? null, weekday]);
  let format = clockFormats.get(key);
  if (!format) {
    const zone = timeZone === undefined ? {} : { timeZone };
    format = new Intl.DateTimeFormat(
      locale,
      weekday ? { weekday: "short", ...zone } : { hour: "2-digit", minute: "2-digit", ...zone },
    );
    clockFormats.set(key, format);
  }
  return format;
}

/** The wall-clock time of an instant ("06:40", "06:40 AM"), with the short weekday in front when asked
 * ("Mon 07:30", "pon. 07:30"); in the device timezone unless `timeZone` names one. */
export function formatClockTime(
  at: Date,
  locale: string,
  options: { readonly weekday?: boolean; readonly timeZone?: string } = {},
): string {
  const time = clockFormat(locale, options.timeZone, false).format(at);
  return options.weekday
    ? `${clockFormat(locale, options.timeZone, true).format(at)} ${time}`
    : time;
}

/** The unit of the privacy mode's banana scale (`@cashu/domain` core/bananas.ts). */
export const BANANA = "🍌";

/**
 * An amount on the banana scale: "🍌 1 000", "-🍌 280", "🍌 1,5". Banana values are approximate by
 * nature, so a plain number is fine here; the digits shrink with the size (whole bananas from 100,
 * one decimal from 10, two below) so a coffee still reads next to the rent.
 */
export function formatBananaValue(
  value: number,
  locale: string,
  options: { readonly signed?: boolean } = {},
): NumberDisplay {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const text = numberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
    useGrouping: "always",
  } as Intl.NumberFormatOptions).format(abs);
  // Rounded zero has no sign, as with money.
  const sign = Number(abs.toFixed(digits)) === 0 ? 0 : value < 0 ? -1 : 1;
  const prefix = sign < 0 ? "-" : sign > 0 && options.signed ? "+" : "";
  return { text: `${prefix}${BANANA} ${text}`, sign };
}

/** `formatBananaValue` as text only. */
export const formatBananas = (
  value: number,
  locale: string,
  options: { readonly signed?: boolean } = {},
): string => formatBananaValue(value, locale, options).text;
