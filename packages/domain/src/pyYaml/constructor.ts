/**
 * PyYAML's `SafeConstructor` for scalar nodes (`constructor.py`: `construct_yaml_null / bool / int /
 * float / timestamp / str`), producing the Python values of `plain.ts`.
 *
 * `constructScalar` returns `{ ok: false }` where Python raises: a `ValueError` (an int / float / date
 * out of range or with bad digits under an explicit tag) and also the few exceptions PyYAML lets escape
 * for odd explicitly tagged scalars (`!!int ""` IndexError, `!!bool maybe` KeyError, `!!timestamp x`
 * AttributeError). Implicitly resolved scalars never hit those: the resolver patterns admit only text
 * the constructors accept.
 */

import { isPySpace, pyLower, unicodeDecimal } from "../text.js";
import type { YamlScalarNode } from "./composer.js";
import { PyDate, PyDateTime, type PyPlain } from "./plain.js";

export type ConstructResult =
  | { readonly ok: true; readonly value: PyPlain }
  | { readonly ok: false };

const FAILED: ConstructResult = Object.freeze({ ok: false });

const BOOL_VALUES: ReadonlyMap<string, boolean> = new Map([
  ["yes", true],
  ["no", false],
  ["true", true],
  ["false", false],
  ["on", true],
  ["off", false],
]);

/** `SafeConstructor.timestamp_regexp` (`re.X`; Python's `$` also matches before a final newline). */
const TIMESTAMP =
  /^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:(?:[Tt]|[ \t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?)?\n?$/;

/** `construct_object(node)` for a scalar with one of the SafeLoader's scalar tags. */
export function constructScalar(node: YamlScalarNode): ConstructResult {
  const value = node.value;
  switch (node.tag) {
    case "tag:yaml.org,2002:null":
      return { ok: true, value: null };
    case "tag:yaml.org,2002:bool": {
      const flag = BOOL_VALUES.get(pyLower(value));
      return flag === undefined ? FAILED : { ok: true, value: flag };
    }
    case "tag:yaml.org,2002:int":
      return wrap(constructInt(value));
    case "tag:yaml.org,2002:float":
      return wrap(constructFloat(value));
    case "tag:yaml.org,2002:timestamp":
      return wrap(constructTimestamp(value));
    default:
      return { ok: true, value };
  }
}

function wrap(value: PyPlain | undefined): ConstructResult {
  return value === undefined ? FAILED : { ok: true, value };
}

/** `construct_yaml_int`; undefined where Python raises. */
function constructInt(text: string): bigint | undefined {
  let value = text.replaceAll("_", "");
  if (value === "") return undefined;
  const sign = value[0] === "-" ? -1n : 1n;
  if (value[0] === "+" || value[0] === "-") value = value.slice(1);
  if (value === "0") return 0n;
  if (value.startsWith("0b")) return times(sign, pyInt(value.slice(2), 2));
  if (value.startsWith("0x")) return times(sign, pyInt(value.slice(2), 16));
  if (value === "") return undefined;
  if (value[0] === "0") return times(sign, pyInt(value, 8));
  if (value.includes(":")) {
    let total = 0n;
    let base = 1n;
    for (const part of value.split(":").reverse()) {
      const digit = pyInt(part, 10);
      if (digit === undefined) return undefined;
      total += digit * base;
      base *= 60n;
    }
    return sign * total;
  }
  return times(sign, pyInt(value, 10));
}

function times(sign: bigint, value: bigint | undefined): bigint | undefined {
  return value === undefined ? undefined : sign * value;
}

/** `construct_yaml_float`; undefined where Python raises. */
function constructFloat(text: string): number | undefined {
  let value = pyLower(text.replaceAll("_", ""));
  if (value === "") return undefined;
  const sign = value[0] === "-" ? -1 : 1;
  if (value[0] === "+" || value[0] === "-") value = value.slice(1);
  if (value === ".inf") return sign * Number.POSITIVE_INFINITY;
  if (value === ".nan") return Number.NaN;
  if (value.includes(":")) {
    let total = 0;
    let base = 1;
    for (const part of value.split(":").reverse()) {
      const digit = pyFloat(part);
      if (digit === undefined) return undefined;
      total += digit * base;
      base *= 60;
    }
    return sign * total;
  }
  const parsed = pyFloat(value);
  return parsed === undefined ? undefined : sign * parsed;
}

/** `construct_yaml_timestamp`; undefined where Python raises. */
function constructTimestamp(text: string): PyDate | undefined {
  const m = TIMESTAMP.exec(text);
  if (m === null) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (!validDate(year, month, day)) return undefined;
  if (m[4] === undefined) return new PyDate(year, month, day);
  const [hour, minute, second] = [Number(m[4]), Number(m[5]), Number(m[6])];
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  const fraction = m[7] ? Number(m[7].slice(0, 6).padEnd(6, "0")) : 0;
  let offset: number | null = null;
  if (m[9] !== undefined) {
    offset = Number(m[10]) * 60 + Number(m[11] ?? "0");
    if (m[9] === "-") offset = -offset;
    // timezone(delta) needs -24h < delta < 24h
    if (Math.abs(offset) >= 24 * 60) return undefined;
  } else if (m[8] !== undefined) {
    offset = 0;
  }
  return new PyDateTime([year, month, day], [hour, minute, second], fraction, offset);
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

/** Python's whitespace strip and Unicode-digit-to-ASCII step of `int()` / `float()`; null on a bad char. */
function asciiDigits(text: string): string | null {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  const cp = (i: number) => (chars[i] as string).codePointAt(0) ?? 0;
  while (start < end && isPySpace(cp(start))) start++;
  while (end > start && isPySpace(cp(end - 1))) end--;
  let out = "";
  for (let i = start; i < end; i++) {
    const code = cp(i);
    if (code < 128) out += chars[i];
    else {
      const digit = unicodeDecimal(code);
      if (digit < 0) return null;
      out += String(digit);
    }
  }
  return out;
}

const BASE_PREFIX: Readonly<Record<number, string>> = { 2: "0b", 8: "0o", 16: "0x" };
const BASE_DIGITS: Readonly<Record<number, RegExp>> = {
  2: /^[01]+$/,
  8: /^[0-7]+$/,
  10: /^[0-9]+$/,
  16: /^[0-9a-f]+$/,
};

/** `int(text, base)` for the bases PyYAML uses (no underscores left: PyYAML removed them). */
function pyInt(text: string, base: 2 | 8 | 10 | 16): bigint | undefined {
  const ascii = asciiDigits(text);
  if (ascii === null) return undefined;
  let body = ascii.toLowerCase();
  let negative = false;
  if (body[0] === "+" || body[0] === "-") {
    negative = body[0] === "-";
    body = body.slice(1);
  }
  const prefix = BASE_PREFIX[base];
  if (prefix !== undefined && body.startsWith(prefix)) body = body.slice(2);
  if (!(BASE_DIGITS[base] as RegExp).test(body)) return undefined;
  const radix = base === 10 ? "" : (prefix as string);
  const magnitude = BigInt(`${radix}${body}`);
  return negative ? -magnitude : magnitude;
}

const FLOAT_TEXT = /^[+-]?(?:(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:e[+-]?[0-9]+)?|inf|infinity|nan)$/;

/** `float(text)` (correctly rounded, like JS `Number` on a decimal literal). */
function pyFloat(text: string): number | undefined {
  const ascii = asciiDigits(text);
  if (ascii === null) return undefined;
  const lower = ascii.toLowerCase();
  if (!FLOAT_TEXT.test(lower)) return undefined;
  const negative = lower.startsWith("-");
  const body = lower.replace(/^[+-]/, "");
  if (body === "nan") return Number.NaN;
  if (body === "inf" || body === "infinity") {
    return negative ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  return Number(lower);
}
