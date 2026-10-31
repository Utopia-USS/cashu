/**
 * The one Python `json.loads` of the domain: the C scanner's grammar and error positions (code
 * points) and messages, with Python's hooks as a `Reader` (what a number, a constant and an object
 * become). Two callers, one scanner:
 *
 * - `parseJson`: as the importers call it, `json.loads(text, parse_float=Decimal,
 *   parse_constant=<refuse>, object_pairs_hook=<refuse duplicates>)`: integers exact (`bigint`, Python
 *   `int` with its 4300-digit limit; or `Decimal` like `parse_int=Decimal`, no limit), numbers with a
 *   fraction or an exponent as `Decimal`, `NaN` / `Infinity` refused, a repeated key refused when its
 *   object closes (inner objects first). Pinned by `budget-canonical.jsonl` (truncations and byte
 *   flips of a valid document) and `inv-importing-json.jsonl` (the `JSONDecodeError` messages).
 * - `parsePyJson`: as the market sources call it, `json.loads` with its defaults (`NaN`, `Infinity`
 *   and `-Infinity` accepted, the last of a repeated key wins, plain objects) and a hook for numbers
 *   so a caller can keep their exact text (`parse_float=Decimal`: NBP rates are exact decimals).
 *   Throws `PyJsonError` (Python `ValueError`) on anything else.
 *
 * Whatever the reader, the grammar is the strict one: positions, nesting limit, BOM, trailing commas.
 */

import { Decimal } from "./decimal.js";

export type JsonValue =
  | null
  | boolean
  | string
  | bigint
  | Decimal
  | readonly JsonValue[]
  | JsonObject;
/** Insertion-ordered (a JS object would move integer-like keys first). */
export type JsonObject = ReadonlyMap<string, JsonValue>;

export type JsonResult =
  | { readonly ok: true; readonly value: JsonValue }
  /** `JSONDecodeError` at `pos` (code point index) with its `msg`. */
  | { readonly ok: false; readonly kind: "decode"; readonly pos: number; readonly msg: string }
  /** `object_pairs_hook` refused a repeated key. */
  | { readonly ok: false; readonly kind: "duplicate_key"; readonly key: string }
  /**
   * Any other `ValueError` (NaN / Infinity, an over-long integer) or too deep nesting; `detail` is
   * the constant's name for `constant`, else a description.
   */
  | {
      readonly ok: false;
      readonly kind: "value";
      readonly reason: "constant" | "int_digits" | "depth";
      readonly detail: string;
    };

/** How integers without a fraction or exponent are read by `parseJson`. */
export interface JsonOptions {
  /** `bigint` (Python `int`, 4300-digit limit) or `Decimal` (`parse_int=Decimal`, no limit). */
  readonly integers: "bigint" | "decimal";
}

/**
 * Nesting deeper than this is refused like Python's `RecursionError` (Python's own depth depends on
 * the C stack, so it is not reproducible; documents nest 3 levels).
 */
const MAX_DEPTH = 2000;
/** `sys.get_int_max_str_digits()` default. */
const MAX_INT_DIGITS = 4300;

class Fail extends Error {
  readonly result: Exclude<JsonResult, { ok: true }>;

  constructor(result: Exclude<JsonResult, { ok: true }>) {
    super("json");
    this.result = result;
  }
}

const decodeError = (pos: number, msg: string): never => {
  throw new Fail({ ok: false, kind: "decode", pos, msg });
};
/** The scanner's `StopIteration(idx)`: no value starts here. */
const noValue = (pos: number): never => decodeError(pos, "Expecting value");
const badConstant = (name: string): never => {
  throw new Fail({ ok: false, kind: "value", reason: "constant", detail: name });
};
/** Python's own depth depends on the C stack; the message is the same for every depth. */
const recursionFailure = (
  container: "object" | "array",
): Extract<JsonResult, { kind: "value" }> => ({
  ok: false,
  kind: "value",
  reason: "depth",
  detail: `maximum recursion depth exceeded while decoding a JSON ${container} from a unicode string`,
});
const tooDeep = (container: "object" | "array"): never => {
  throw new Fail(recursionFailure(container));
};

const unterminated = (begin: number): never =>
  decodeError(begin, "Unterminated string starting at");

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const HEX = /^[0-9a-fA-F]$/;

/** What `json.loads` hooks decide: the value of a number, a constant and a closed object. */
interface Reader {
  /** `parse_float` / `parse_int`; `integer` is true for a literal without fraction or exponent. */
  number(text: string, integer: boolean): unknown;
  /** `parse_constant`. */
  constant(name: "NaN" | "Infinity" | "-Infinity"): unknown;
  /** `object_pairs_hook`: runs as an object closes. */
  object(pairs: readonly (readonly [string, unknown])[]): unknown;
}

/** The importers' hooks: exact numbers, constants and repeated keys refused, insertion-ordered maps. */
const importerReader = (options: JsonOptions): Reader => ({
  number(text, integer) {
    if (!integer || options.integers === "decimal") return Decimal.parse(text);
    const digits = text.replace("-", "").length;
    if (digits > MAX_INT_DIGITS) {
      throw new Fail({
        ok: false,
        kind: "value",
        reason: "int_digits",
        detail: `Exceeds the limit (${MAX_INT_DIGITS} digits) for integer string conversion: value has ${digits} digits; use sys.set_int_max_str_digits() to increase the limit`,
      });
    }
    return BigInt(text);
  },
  constant: badConstant,
  object(pairs) {
    const map = new Map<string, JsonValue>();
    for (const [k, v] of pairs) {
      if (map.has(k)) throw new Fail({ ok: false, kind: "duplicate_key", key: k });
      map.set(k, v as JsonValue);
    }
    return map;
  },
});

/** `json.loads` defaults: floats, `NaN` and friends accepted, the last of a repeated key wins. */
const defaultReader = (number: NumberReader): Reader => ({
  number,
  constant: (name) =>
    name === "NaN"
      ? Number.NaN
      : name === "Infinity"
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY,
  // fromEntries defines own properties (a `__proto__` key stays data) and the last pair wins.
  object: (pairs) => Object.fromEntries(pairs),
});

class Scanner {
  private readonly s: readonly string[];
  private readonly reader: Reader;
  /** The container being read last: names the recursion error when the JS stack gives out first. */
  innermost: "object" | "array" = "object";

  constructor(text: string, reader: Reader) {
    this.s = Array.from(text);
    this.reader = reader;
  }

  get length(): number {
    return this.s.length;
  }

  skipWs(idx: number): number {
    let i = idx;
    while (isWs(this.s[i])) i++;
    return i;
  }

  /** `scan_once(s, idx)` -> [value, next index]. */
  value(idx: number, depth: number): [unknown, number] {
    const s = this.s;
    const c = s[idx];
    if (c === undefined) return noValue(idx);
    const word = (w: string) => s.slice(idx, idx + w.length).join("") === w;
    switch (c) {
      case '"':
        return this.string(idx + 1);
      case "{":
        return this.object(idx + 1, depth + 1);
      case "[":
        return this.array(idx + 1, depth + 1);
      case "n":
        if (word("null")) return [null, idx + 4];
        break;
      case "t":
        if (word("true")) return [true, idx + 4];
        break;
      case "f":
        if (word("false")) return [false, idx + 5];
        break;
      case "N":
        if (word("NaN")) return [this.reader.constant("NaN"), idx + 3];
        break;
      case "I":
        if (word("Infinity")) return [this.reader.constant("Infinity"), idx + 8];
        break;
      case "-":
        if (word("-Infinity")) return [this.reader.constant("-Infinity"), idx + 9];
        break;
    }
    return this.number(idx);
  }

  /** `_match_number_unicode`. */
  private number(start: number): [unknown, number] {
    const s = this.s;
    const end = s.length - 1;
    let idx = start;
    if (s[idx] === "-") {
      idx++;
      if (idx > end) return noValue(start);
    }
    const first = s[idx];
    if (first !== undefined && first >= "1" && first <= "9") {
      idx++;
      while (idx <= end && isDigit(s[idx])) idx++;
    } else if (first === "0") {
      idx++;
    } else {
      return noValue(start);
    }
    let isFloat = false;
    if (idx < end && s[idx] === "." && isDigit(s[idx + 1])) {
      isFloat = true;
      idx += 2;
      while (idx <= end && isDigit(s[idx])) idx++;
    }
    if (idx < end && (s[idx] === "e" || s[idx] === "E")) {
      const eStart = idx;
      idx++;
      if (idx < end && (s[idx] === "-" || s[idx] === "+")) idx++;
      while (idx <= end && isDigit(s[idx])) idx++;
      if (isDigit(s[idx - 1])) isFloat = true;
      else idx = eStart;
    }
    const text = s.slice(start, idx).join("");
    return [this.reader.number(text, !isFloat), idx];
  }

  /** `scanstring_unicode(s, end, strict=True)`; `end` is just after the opening quote. */
  string(endIn: number): [string, number] {
    const s = this.s;
    const len = s.length;
    const begin = endIn - 1;
    let end = endIn;
    let out = "";
    for (;;) {
      let next = end;
      let c: string | undefined;
      for (; next < len; next++) {
        c = s[next] as string;
        if (c === '"' || c === "\\") break;
        if ((c.codePointAt(0) as number) <= 0x1f)
          return decodeError(next, "Invalid control character at");
      }
      if (next >= len) return unterminated(begin);
      out += s.slice(end, next).join("");
      next++;
      if (c === '"') return [out, next];
      if (next === len) return unterminated(begin);
      const esc = s[next] as string;
      if (esc !== "u") {
        end = next + 1;
        const mapped = (
          { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<
            string,
            string
          >
        )[esc];
        if (mapped === undefined) return decodeError(end - 2, "Invalid \\escape");
        out += mapped;
        continue;
      }
      next++;
      end = next + 4;
      if (end >= len) return decodeError(next - 1, "Invalid \\uXXXX escape");
      const hex4 = (from: number) => {
        const digits = s.slice(from, from + 4);
        if (!digits.every((d) => HEX.test(d)))
          return decodeError(from - 1, "Invalid \\uXXXX escape");
        return Number.parseInt(digits.join(""), 16);
      };
      let cp = hex4(next);
      next = end;
      if (
        cp >= 0xd800 &&
        cp <= 0xdbff &&
        end + 6 < len &&
        s[next] === "\\" &&
        s[next + 1] === "u"
      ) {
        const low = hex4(next + 2);
        if (low >= 0xdc00 && low <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (low - 0xdc00);
          end += 6;
        }
      }
      out += String.fromCharCode(
        ...(cp > 0xffff
          ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)]
          : [cp]),
      );
    }
  }

  private object(start: number, depth: number): [unknown, number] {
    this.innermost = "object";
    if (depth > MAX_DEPTH) return tooDeep("object");
    const s = this.s;
    const pairs: [string, unknown][] = [];
    let idx = this.skipWs(start);
    if (s[idx] !== "}") {
      for (;;) {
        if (s[idx] !== '"')
          return decodeError(idx, "Expecting property name enclosed in double quotes");
        const [key, afterKey] = this.string(idx + 1);
        idx = this.skipWs(afterKey);
        if (s[idx] !== ":") return decodeError(idx, "Expecting ':' delimiter");
        idx = this.skipWs(idx + 1);
        const [val, afterVal] = this.value(idx, depth);
        pairs.push([key, val]);
        idx = this.skipWs(afterVal);
        if (s[idx] === "}") break;
        if (s[idx] !== ",") return decodeError(idx, "Expecting ',' delimiter");
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (s[idx] === "}")
          return decodeError(comma, "Illegal trailing comma before end of object");
      }
    }
    return [this.reader.object(pairs), idx + 1];
  }

  private array(start: number, depth: number): [unknown, number] {
    this.innermost = "array";
    if (depth > MAX_DEPTH) return tooDeep("array");
    const s = this.s;
    const items: unknown[] = [];
    let idx = this.skipWs(start);
    if (s[idx] !== "]") {
      for (;;) {
        const [val, after] = this.value(idx, depth);
        items.push(val);
        idx = this.skipWs(after);
        if (s[idx] === "]") break;
        if (s[idx] !== ",") return decodeError(idx, "Expecting ',' delimiter");
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (s[idx] === "]") return decodeError(comma, "Illegal trailing comma before end of array");
      }
    }
    return [items, idx + 1];
  }
}

type Scanned = { readonly ok: true; readonly value: unknown } | Exclude<JsonResult, { ok: true }>;

function scan(text: string, reader: Reader): Scanned {
  const scanner = new Scanner(text, reader);
  try {
    if (text.startsWith("\ufeff")) {
      return decodeError(0, "Unexpected UTF-8 BOM (decode using utf-8-sig)");
    }
    const [value, end] = scanner.value(scanner.skipWs(0), 0);
    const after = scanner.skipWs(end);
    if (after !== scanner.length) return decodeError(after, "Extra data");
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Fail) return error.result;
    // The JS stack gave out before `MAX_DEPTH`: Python's RecursionError, the same refusal.
    if (error instanceof RangeError) return recursionFailure(scanner.innermost);
    throw error;
  }
}

/** `json.loads(text, ...)` with the importers' hooks (see the header). */
export function parseJson(text: string, options: JsonOptions = { integers: "bigint" }): JsonResult {
  const scanned = scan(text, importerReader(options));
  return scanned.ok ? { ok: true, value: scanned.value as JsonValue } : scanned;
}

/** Python `json.JSONDecodeError` (a `ValueError`) and the other refusals of `json.loads`. */
export class PyJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyJsonError";
  }
}

/** Turns one number literal into a value; `integer` is true for a literal without fraction or exponent. */
export type NumberReader = (text: string, integer: boolean) => unknown;

const asFloat: NumberReader = (text) => Number(text);

/**
 * `json.loads(text, parse_float=..., parse_int=...)` with Python's defaults otherwise (both numbers
 * via `number`, a float unless given). Objects are plain records. Throws `PyJsonError`.
 */
export function parsePyJson(text: string, number: NumberReader = asFloat): unknown {
  const scanned = scan(text, defaultReader(number));
  if (scanned.ok) return scanned.value;
  if (scanned.kind === "decode") {
    const { line, column } = lineColumn(text, scanned.pos);
    throw new PyJsonError(`${scanned.msg}: line ${line} column ${column} (char ${scanned.pos})`);
  }
  throw new PyJsonError(scanned.kind === "value" ? scanned.detail : `duplicate key ${scanned.key}`);
}

/** A plain JSON object (Python `isinstance(x, dict)`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Python `isinstance(x, int | float) and not isinstance(x, bool)` for a value of `parsePyJson`. */
export function isPyNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** `JSONDecodeError.lineno` / `colno` of a position (code points). */
export function lineColumn(text: string, pos: number): { line: number; column: number } {
  const cps = Array.from(text).slice(0, pos);
  const lastNl = cps.lastIndexOf("\n");
  return { line: cps.filter((c) => c === "\n").length + 1, column: pos - lastNl };
}
