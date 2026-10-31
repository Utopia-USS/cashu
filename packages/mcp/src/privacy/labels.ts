/**
 * Sensitivity labels (port of `core/mcp/labels.py`). Every value a tool returns is wrapped in a
 * `Labelled` built with the helpers below; the redactor decides per label and privacy level what may
 * be sent. An unlabelled leaf in a tool's result is a programming error and the call fails closed.
 *
 * | label | strict | amounts |
 * |---|---|---|
 * | `identifier` (IBAN, account number, person name, file names with numbers) | dropped | dropped |
 * | `amount` (money values, quantities, prices x quantity) | dropped | sent |
 * | `merchant` (payee names; private persons -> opaque ref) | sent | sent |
 * | `percent`, `date`, `category`, `symbol` (public tickers / ISINs) | sent | sent |
 * | `level` (a market price level of a public instrument) | sent | sent |
 * | `text` (scrubbed: identifiers always, money amounts in strict) | sent | sent |
 * | `market` (server-made text about public market data; identifiers scrubbed) | sent | sent |
 * | `count` (non-money integers), `ref` (local row ids), `flag` (booleans) | sent | sent |
 * | `account` (the generated "<institution> <type> <n>" label, never the stored name) | sent | sent |
 *
 * Values follow Python's types: a `number` is a Python float, a `bigint` a Python int, a `Decimal`
 * a Python Decimal, a domain `DateTime` a Python datetime and an ISO string a date. Percent values
 * are fractions (`weight` 0.153 = 15.3 %) or percentage points (`*_pp`); the key name says which.
 */

import {
  type DateTime,
  DEFAULT_CONTEXT,
  Decimal,
  D as dec,
  floatRepr,
  formatFloat,
  PY_D,
  PY_END,
  roundFloat,
  roundFloatToInt,
  uRegex,
} from "@cashu/domain";
import { macro } from "@cashu/domain/investments";

export type Sensitivity =
  | "identifier"
  | "amount"
  | "merchant"
  | "percent"
  | "date"
  | "category"
  | "text"
  | "symbol"
  | "count"
  | "ref"
  | "flag"
  | "account"
  | "level"
  | "market";

export const SENSITIVITIES: readonly Sensitivity[] = [
  "identifier",
  "amount",
  "merchant",
  "percent",
  "date",
  "category",
  "text",
  "symbol",
  "count",
  "ref",
  "flag",
  "account",
  "level",
  "market",
];

/** What a labelled leaf may hold (see the module doc for the Python type each stands for). */
export type LeafValue = null | boolean | string | number | bigint | Decimal | DateTime;

export class Labelled {
  readonly value: LeafValue;
  readonly label: Sensitivity;

  constructor(value: LeafValue, label: Sensitivity) {
    this.value = value;
    this.label = label;
  }
}

/** A handler's result: labelled leaves inside plain objects and arrays. */
export type LabelledTree =
  | Labelled
  | null
  | readonly LabelledTree[]
  | { readonly [key: string]: LabelledTree };

type Numeric = number | bigint | Decimal;

/** Python `float(value)` of a number-like leaf. */
export function pyFloat(value: Numeric): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number(value.toString());
}

/**
 * Floats and Decimals rounded to `digits` places (ints and null unchanged): an unrounded float
 * (FX conversions, 0.1 + 0.2) would carry a 10+ digit fraction the leak check takes for an account
 * number.
 */
function rounded(value: Numeric | null, digits: number): number | bigint | null {
  if (value === null || typeof value === "bigint") return value;
  return roundFloat(pyFloat(value), digits);
}

export function identifier(value: LeafValue): Labelled {
  return new Labelled(value, "identifier");
}

/** Money (2 places by default); quantities and per-unit prices pass `digits = 8`. */
export function amount(value: Numeric | null, digits = 2): Labelled {
  return new Labelled(rounded(value, digits), "amount");
}

export function merchant(value: string | null): Labelled {
  return new Labelled(value, "merchant");
}

export function pct(value: Numeric | null, digits = 6): Labelled {
  return new Labelled(value === null ? null : roundFloat(pyFloat(value), digits), "percent");
}

/** A date (ISO `YYYY-MM-DD` string), a datetime, or a date-like string. */
export function date(value: string | DateTime | null): Labelled {
  return new Labelled(value, "date");
}

export function category(value: string | null): Labelled {
  return new Labelled(value, "category");
}

export function text(value: string | null): Labelled {
  return new Labelled(value, "text");
}

export function symbol(value: string | null): Labelled {
  return new Labelled(value, "symbol");
}

/** An integral JS number is taken as the Python int it stands for (counts and refs are ints). */
function asInt(value: number | bigint): number | bigint {
  return typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value;
}

export function count(value: number | bigint | null): Labelled {
  return new Labelled(value === null ? null : asInt(value), "count");
}

export function ref(value: number | bigint | string | null): Labelled {
  return new Labelled(value === null || typeof value === "string" ? value : asInt(value), "ref");
}

export function flag(value: boolean | null): Labelled {
  return new Labelled(value, "flag");
}

export function account(value: string | null): Labelled {
  return new Labelled(value, "account");
}

/**
 * A market price level of a public instrument (per unit, never times a quantity): not a personal
 * amount, sent in both modes. Owner-named instruments' prices stay `amount`.
 */
export function level(value: Numeric | null): Labelled {
  return new Labelled(value === null ? null : roundFloat(pyFloat(value), 8), "level");
}

/** `Decimal(str(x))` of a share operand; non-finite floats stay floats (Decimal NaN / Infinity). */
function shareOperand(value: Numeric): Decimal | number {
  if (value instanceof Decimal) return value;
  if (typeof value === "bigint") return dec(value);
  return Number.isFinite(value) ? dec(floatRepr(value)) : value;
}

/** Python truthiness of a number-like value. */
function isZero(value: Numeric): boolean {
  if (value instanceof Decimal) return value.isZero();
  if (typeof value === "bigint") return value === 0n;
  return value === 0;
}

/** `part / base` as a percent fraction (null when either is missing or the base is 0). */
export function share(part: Numeric | null, base: Numeric | null): Labelled {
  if (part === null || base === null || isZero(base)) return pct(null);
  const p = shareOperand(part);
  const b = shareOperand(base);
  if (typeof p === "number" || typeof b === "number") {
    // Decimal arithmetic with a NaN / Infinity operand, as Python's default context does it
    const pf = typeof p === "number" ? p : p.toFloat();
    const bf = typeof b === "number" ? b : b.toFloat();
    if (Number.isNaN(pf) || Number.isNaN(bf)) return pct(Number.NaN);
    if (!Number.isFinite(pf) && !Number.isFinite(bf)) {
      throw new RangeError("decimal.InvalidOperation: infinity / infinity");
    }
    return pct(pf / bf);
  }
  return pct(p.div(b, DEFAULT_CONTEXT));
}

// --------------------------------------------------------------------------- market text

/**
 * The macro metric labels (P6, the investments macro module's `METRIC_LABELS`, Polish): the only
 * words a `market` value may carry besides formatted numbers and macro card summaries.
 */
export const MARKET_LABELS: ReadonlySet<string> = macro.METRIC_LABELS;

const MARKET_NUMBER = uRegex(
  `^[+\\-]?${PY_D}{1,3}(?: ${PY_D}{3})*(?:,${PY_D}+)?(?: (?:%|pp|bp|mln|mld))?${PY_END}`,
);

/** From this absolute value a screening threshold is written compactly (`compactNumber`). */
export const COMPACT_FROM = 1_000_000;

/**
 * Checks a macro card summary (investments `macro.texts.summary_ok`); the investments module
 * supplies it (`summaryOk` / `summaryChecker` of the domain macro module). Without one, only labels
 * and numbers are market text.
 */
export type SummaryCheck = (text: string) => boolean;

export const NO_SUMMARIES: SummaryCheck = () => false;

/**
 * A large number as short Polish text, `1 mld` / `1,5 mld` / `500 mln` / `2 500 mld` (3 significant
 * digits at most, decimal comma, no trailing zeros): never the long digit run the leak check takes
 * for an account number.
 */
export function compactNumber(value: number): string {
  const number = value;
  let scale = Math.abs(number) >= 1e9 ? 1e9 : 1e6;
  let unit = Math.abs(number) >= 1e9 ? "mld" : "mln";
  if (unit === "mln" && roundFloatToInt(Math.abs(number) / 1e6) >= 1000n) {
    scale = 1e9;
    unit = "mld";
  }
  const scaled = number / scale;
  const decimals = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  let out = formatFloat(Math.abs(scaled), `,.${decimals}f`).replaceAll(",", " ");
  if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "");
  const sign = number < 0 && stripChars(out, "0 .") !== "" ? "-" : "";
  return `${sign}${out.replace(".", ",")} ${unit}`;
}

/** Python `s.strip(chars)`. */
function stripChars(s: string, chars: string): string {
  const set = new Set(chars);
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && set.has(cps[start] as string)) start++;
  while (end > start && set.has(cps[end - 1] as string)) end--;
  return cps.slice(start, end).join("");
}

/**
 * A `market` value is a known macro metric label, a formatted number (digits, sign, spaces,
 * decimal comma, `%` / `pp` / `bp` / `mln` / `mld`) or a macro card summary (only the summary
 * builder's vocabulary): nothing else may use the strict-mode exemption.
 */
export function marketOk(value: unknown, summaryOk: SummaryCheck = NO_SUMMARIES): boolean {
  if (typeof value !== "string") return false;
  if (MARKET_LABELS.has(value) || MARKET_NUMBER.test(value)) return true;
  return summaryOk(value);
}

/**
 * Text the server builds from public market data only (a macro metric's label and its formatted
 * value, a macro card summary). Anything else is refused here and again by the redactor.
 */
export function market(value: string | null, summaryOk: SummaryCheck = NO_SUMMARIES): Labelled {
  if (value !== null && !marketOk(value, summaryOk)) {
    throw new RangeError("not a macro metric label or a formatted market number");
  }
  return new Labelled(value, "market");
}
