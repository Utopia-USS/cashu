/**
 * Typed, range-checked reading of a raw `params:` map (`rules/params.py`), and of the strategy.yaml
 * sections of the same shape (`data`, `contributions`, `allocation.rebalance`, `buckets[].match`,
 * `benchmark`, `notifications`, `review`). Raw values are the Python values `SafeConstructor` builds
 * (`PyPlain`: an int is a bigint, a float a number), so the int / float distinction Python checks with
 * `isinstance` survives.
 */

import { Decimal, floatRepr } from "../../decimal.js";
import { type Currency, tryCurrency } from "../../money.js";
import { isPyMap, isPyNumber, PyDate, type PyPlain, type PyPlainMap } from "../../pyYaml/plain.js";
import { pyStrip } from "../../text.js";
import { ASSET_CLASSES, type AssetClass } from "../domain/enums.js";
import { didYouMean } from "./hints.js";

/** One problem with a params map (`ParamIssue`). */
export interface ParamIssue {
  /** Param name or path relative to the map (`threshold`, `tags[1]`); empty for the map itself. */
  readonly key: string;
  /** English, one sentence. */
  readonly message: string;
  /** Errors reject the strategy; warnings (an unknown key) are only reported. */
  readonly isError: boolean;
  /** 0-based character offset inside the value's text (an expression error), else null. */
  readonly offset: number | null;
}

/** Collector passed to `RuleKind.parseParams`; the strategy loader maps keys to YAML lines. */
export class ParamErrors {
  private readonly list: ParamIssue[] = [];

  get issues(): readonly ParamIssue[] {
    return [...this.list];
  }

  get hasErrors(): boolean {
    return this.list.some((issue) => issue.isError);
  }

  get errorCount(): number {
    return this.list.filter((issue) => issue.isError).length;
  }

  error(key: string, message: string): void {
    this.list.push({ key, message, isError: true, offset: null });
  }

  /** An error at `offset` (0-based) inside the text value of `key`. */
  errorAt(key: string, message: string, offset: number): void {
    this.list.push({ key, message, isError: true, offset });
  }

  warning(key: string, message: string): void {
    this.list.push({ key, message, isError: false, offset: null });
  }
}

export interface NumberBounds {
  readonly fallback?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMin?: boolean;
  readonly exclusiveMax?: boolean;
}

export interface IntegerBounds {
  readonly fallback?: number;
  readonly minimum?: number;
  readonly maximum?: number;
}

/**
 * Reads values out of a raw map and records problems in a `ParamErrors`. Every read registers its key
 * as known; `finish` then warns about the remaining (unknown) keys with a closest-known-key hint.
 * Reads never throw: on a problem they record an error and return a fallback. Required values (no
 * `fallback`) report `<key> is required` when missing; `optional*` reads return null. YAML null counts
 * as missing.
 */
export class ParamReader {
  readonly raw: PyPlainMap;
  readonly errors: ParamErrors;
  private readonly known: string[] = [];

  constructor(raw: PyPlainMap, errors: ParamErrors) {
    this.raw = raw;
    this.errors = errors;
  }

  get knownKeys(): readonly string[] {
    return [...this.known];
  }

  /** True when `key` is present with a non-null value (also marks it as known). */
  has(key: string): boolean {
    this.mark(key);
    return this.value(key) !== null;
  }

  /** A number (int or float) as a float. When missing: `fallback`, or an error if there is none. */
  number(key: string, bounds: NumberBounds = {}): number {
    const value = this.readNumber(key, bounds, bounds.fallback === undefined);
    return value ?? bounds.fallback ?? 0;
  }

  optionalNumber(key: string, bounds: Omit<NumberBounds, "fallback"> = {}): number | null {
    return this.readNumber(key, bounds, false);
  }

  /** A whole number. When missing: `fallback`, or an error if there is none. */
  integer(key: string, bounds: IntegerBounds = {}): number {
    const value = this.readInteger(key, bounds, bounds.fallback === undefined);
    return value ?? bounds.fallback ?? 0;
  }

  optionalInteger(key: string, bounds: Omit<IntegerBounds, "fallback"> = {}): number | null {
    return this.readInteger(key, bounds, false);
  }

  /** An exact amount (YAML number or numeric text). When missing: `fallback`, or an error. */
  decimal(
    key: string,
    opts: {
      readonly fallback?: Decimal;
      readonly minimum?: Decimal;
      readonly exclusiveMin?: boolean;
    } = {},
  ): Decimal {
    this.mark(key);
    const fallback = opts.fallback ?? Decimal.fromInt(0);
    const value = this.value(key);
    if (value === null) {
      if (opts.fallback === undefined) this.errors.error(key, `${key} is required`);
      return fallback;
    }
    const parsed = toDecimal(value);
    if (parsed === null) {
      this.errors.error(key, `${key} must be a number, got ${show(value)}`);
      return fallback;
    }
    const minimum = opts.minimum;
    if (minimum !== undefined && (opts.exclusiveMin ? parsed.lte(minimum) : parsed.lt(minimum))) {
      const relation = opts.exclusiveMin ? "greater than" : "at least";
      this.errors.error(
        key,
        `${key} must be ${relation} ${minimum.toString()}, got ${parsed.toString()}`,
      );
      return fallback;
    }
    return parsed;
  }

  /** A text value, or null when missing. */
  optionalString(key: string): string | null {
    this.mark(key);
    const value = this.value(key);
    if (value === null) return null;
    if (typeof value === "string") return value;
    this.errors.error(key, `${key} must be text, got ${show(value)}`);
    return null;
  }

  /** One text or a list of texts, trimmed, duplicates dropped; empty when missing. */
  strings(key: string): readonly string[] {
    this.mark(key);
    const value = this.value(key);
    if (value === null) return [];
    const isList = Array.isArray(value);
    const items: readonly PyPlain[] = isList ? (value as readonly PyPlain[]) : [value];
    const result: string[] = [];
    for (const [index, item] of items.entries()) {
      const itemKey = isList ? `${key}[${index}]` : key;
      let text: string;
      if (typeof item === "string" && pyStrip(item)) text = pyStrip(item);
      else if (isPyNumber(item))
        text = typeof item === "bigint" ? item.toString() : floatRepr(item);
      else {
        this.errors.error(itemKey, `${key} must be text or a list of texts, got ${show(item)}`);
        continue;
      }
      if (!result.includes(text)) result.push(text);
    }
    return result;
  }

  /** One asset class or a list of them, by wire name (`treasury_bond`); empty when missing. */
  assetClasses(key: string): ReadonlySet<AssetClass> {
    const names: readonly string[] = ASSET_CLASSES;
    const result = new Set<AssetClass>();
    for (const name of this.strings(key)) {
      if (names.includes(name)) result.add(name as AssetClass);
      else {
        this.errors.error(
          key,
          `Unknown asset class "${name}"${didYouMean(name, names)}; known: ${names.join(", ")}`,
        );
      }
    }
    return result;
  }

  /** One currency code or a list of them; empty when missing. */
  currencies(key: string): ReadonlySet<Currency> {
    const result = new Set<Currency>();
    for (const code of this.strings(key)) {
      const currency = parseCurrency(code);
      if (currency === null)
        this.errors.error(key, `"${code}" is not a three-letter ISO currency code`);
      else result.add(currency);
    }
    return result;
  }

  /** One enum value by wire name (`values` in declaration order), `fallback` when missing. */
  enumValue<E extends string>(key: string, values: readonly E[], fallback: E): E {
    const name = this.optionalString(key);
    if (name === null) return fallback;
    if ((values as readonly string[]).includes(name)) return name as E;
    this.errors.error(
      key,
      `Unknown value "${name}" for ${key}${didYouMean(name, values)}; allowed: ${values.join(", ")}`,
    );
    return fallback;
  }

  /** Warns about every key that was never read (typo hint against the read keys + `alsoKnown`). */
  finish(alsoKnown: Iterable<string> = []): void {
    const known = [...this.known];
    for (const key of alsoKnown) if (!this.known.includes(key)) known.push(key);
    for (const key of this.raw.keys()) {
      if (!known.includes(key)) {
        this.errors.warning(key, `Unknown key "${key}"${didYouMean(key, known)}; it is ignored`);
      }
    }
  }

  // --- internals ------------------------------------------------------------------------------

  private value(key: string): PyPlain {
    return this.raw.get(key) ?? null;
  }

  private mark(key: string): void {
    if (!this.known.includes(key)) this.known.push(key);
  }

  private readNumber(
    key: string,
    bounds: Omit<NumberBounds, "fallback">,
    required: boolean,
  ): number | null {
    this.mark(key);
    const value = this.value(key);
    if (value === null) {
      if (required) this.errors.error(key, `${key} is required`);
      return null;
    }
    if (!isPyNumber(value)) {
      this.errors.error(key, `${key} must be a number, got ${show(value)}`);
      return null;
    }
    // float(int): Python raises OverflowError past 1.8e308 where Number() gives Infinity
    const number = Number(value);
    if (!Number.isFinite(number)) {
      this.errors.error(key, `${key} must be a finite number`);
      return null;
    }
    const problem = rangeProblem(number, bounds);
    if (problem !== null) {
      const hint = bounds.maximum === 1 && number > 1 ? " (fractions: 0.15 = 15%)" : "";
      this.errors.error(key, `${key} must be ${problem}, got ${formatNumber(number)}${hint}`);
      return null;
    }
    return number;
  }

  /**
   * Range-checked exactly on the Python int; returned as a number (a value past 2^53 loses digits,
   * which only an absurd strategy.yaml can reach).
   */
  private readInteger(
    key: string,
    bounds: Omit<IntegerBounds, "fallback">,
    required: boolean,
  ): number | null {
    this.mark(key);
    const value = this.value(key);
    if (value === null) {
      if (required) this.errors.error(key, `${key} is required`);
      return null;
    }
    if (typeof value !== "bigint") {
      this.errors.error(key, `${key} must be a whole number, got ${show(value)}`);
      return null;
    }
    const tooLow = bounds.minimum !== undefined && value < BigInt(bounds.minimum);
    const tooHigh = bounds.maximum !== undefined && value > BigInt(bounds.maximum);
    if (tooLow || tooHigh) {
      this.errors.error(key, `${key} must be ${rangeText(bounds)}, got ${value.toString()}`);
      return null;
    }
    return Number(value);
  }
}

/** `parse_currency`: a validated currency, or null when `code` is not three letters. */
export function parseCurrency(code: string): Currency | null {
  return tryCurrency(code);
}

/** `format_number`: `5` for 5.0, `0.25` for 0.25 (Python `str()` past 1e15). */
export function formatNumber(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  return floatRepr(value);
}

function rangeProblem(value: number, bounds: Omit<NumberBounds, "fallback">): string | null {
  const { minimum, maximum } = bounds;
  const tooLow =
    minimum !== undefined && (bounds.exclusiveMin ? value <= minimum : value < minimum);
  const tooHigh =
    maximum !== undefined && (bounds.exclusiveMax ? value >= maximum : value > maximum);
  return tooLow || tooHigh ? rangeText(bounds) : null;
}

function rangeText(bounds: Omit<NumberBounds, "fallback">): string {
  const parts: string[] = [];
  if (bounds.minimum !== undefined) {
    parts.push(
      `${bounds.exclusiveMin ? "greater than" : "at least"} ${formatNumber(bounds.minimum)}`,
    );
  }
  if (bounds.maximum !== undefined) {
    parts.push(`${bounds.exclusiveMax ? "less than" : "at most"} ${formatNumber(bounds.maximum)}`);
  }
  return parts.join(" and ");
}

/** `_to_decimal`. */
function toDecimal(value: PyPlain): Decimal | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "bigint") return Decimal.fromInt(value);
  if (typeof value === "number") {
    return Number.isFinite(value) ? Decimal.parse(floatRepr(value)) : null;
  }
  if (typeof value === "string") {
    try {
      return Decimal.parse(pyStrip(value));
    } catch {
      // InvalidOperation, or a non-finite literal (`is_finite()` false)
      return null;
    }
  }
  return null;
}

/** `_show`: a value as an error message names it. */
function show(value: PyPlain): string {
  if (typeof value === "string") return `"${value}"`;
  if (isPyMap(value)) return "a mapping";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value instanceof PyDate) return value.isoformat();
  if (value === null) return "None";
  return typeof value === "bigint" ? value.toString() : floatRepr(value as number);
}
