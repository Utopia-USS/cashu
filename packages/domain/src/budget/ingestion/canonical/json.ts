/**
 * Python's `json.loads(text, parse_float=Decimal, parse_constant=<refuse>, object_pairs_hook=<refuse
 * duplicates>)` as the budget import calls it: the C scanner's grammar and error positions (code
 * points), integers exact (`bigint`, Python `int` with its 4300-digit limit), numbers with a fraction
 * or an exponent as `Decimal`, a repeated key refused when its object closes (inner objects first).
 * Pinned by `budget-canonical.jsonl` (truncations and byte flips of a valid document).
 */

import { Decimal } from "../../../decimal.js";

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
  /** `JSONDecodeError` at `pos` (code point index). */
  | { readonly ok: false; readonly kind: "decode"; readonly pos: number }
  | { readonly ok: false; readonly kind: "duplicate_key" }
  /** Any other `ValueError` (NaN / Infinity, an over-long integer) or too deep nesting. */
  | { readonly ok: false; readonly kind: "value" };

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

const decodeError = (pos: number): never => {
  throw new Fail({ ok: false, kind: "decode", pos });
};
/** The scanner's `StopIteration(idx)`: no value starts here ("Expecting value"). */
const noValue = decodeError;

const isWs = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const HEX = /^[0-9a-fA-F]$/;

class Scanner {
  private readonly s: readonly string[];

  constructor(text: string) {
    this.s = Array.from(text);
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
  value(idx: number, depth: number): [JsonValue, number] {
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
        if (word("NaN")) throw new Fail({ ok: false, kind: "value" });
        break;
      case "I":
        if (word("Infinity")) throw new Fail({ ok: false, kind: "value" });
        break;
      case "-":
        if (word("-Infinity")) throw new Fail({ ok: false, kind: "value" });
        break;
    }
    return this.number(idx);
  }

  /** `_match_number_unicode`. */
  private number(start: number): [JsonValue, number] {
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
    if (isFloat) return [Decimal.parse(text), idx];
    if (text.replace("-", "").length > MAX_INT_DIGITS) throw new Fail({ ok: false, kind: "value" });
    return [BigInt(text), idx];
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
        if ((c.codePointAt(0) as number) <= 0x1f) return decodeError(next);
      }
      if (next >= len) return decodeError(begin); // unterminated
      out += s.slice(end, next).join("");
      next++;
      if (c === '"') return [out, next];
      if (next === len) return decodeError(begin);
      const esc = s[next] as string;
      if (esc !== "u") {
        end = next + 1;
        const mapped = (
          { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<
            string,
            string
          >
        )[esc];
        if (mapped === undefined) return decodeError(end - 2);
        out += mapped;
        continue;
      }
      next++;
      end = next + 4;
      if (end >= len) return decodeError(next - 1);
      const hex4 = (from: number) => {
        const digits = s.slice(from, from + 4);
        if (!digits.every((d) => HEX.test(d))) return decodeError(from - 1);
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

  private object(start: number, depth: number): [JsonValue, number] {
    if (depth > MAX_DEPTH) throw new Fail({ ok: false, kind: "value" });
    const s = this.s;
    const pairs: [string, JsonValue][] = [];
    let idx = this.skipWs(start);
    if (s[idx] !== "}") {
      for (;;) {
        if (s[idx] !== '"') return decodeError(idx);
        const [key, afterKey] = this.string(idx + 1);
        idx = this.skipWs(afterKey);
        if (s[idx] !== ":") return decodeError(idx);
        idx = this.skipWs(idx + 1);
        const [val, afterVal] = this.value(idx, depth);
        pairs.push([key, val]);
        idx = this.skipWs(afterVal);
        if (s[idx] === "}") break;
        if (s[idx] !== ",") return decodeError(idx);
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (s[idx] === "}") return decodeError(comma); // illegal trailing comma
      }
    }
    // object_pairs_hook runs as the object closes: a repeated key fails here, inner objects first.
    const map = new Map<string, JsonValue>();
    for (const [k, v] of pairs) {
      if (map.has(k)) throw new Fail({ ok: false, kind: "duplicate_key" });
      map.set(k, v);
    }
    return [map, idx + 1];
  }

  private array(start: number, depth: number): [JsonValue, number] {
    if (depth > MAX_DEPTH) throw new Fail({ ok: false, kind: "value" });
    const s = this.s;
    const items: JsonValue[] = [];
    let idx = this.skipWs(start);
    if (s[idx] !== "]") {
      for (;;) {
        const [val, after] = this.value(idx, depth);
        items.push(val);
        idx = this.skipWs(after);
        if (s[idx] === "]") break;
        if (s[idx] !== ",") return decodeError(idx);
        const comma = idx;
        idx = this.skipWs(idx + 1);
        if (s[idx] === "]") return decodeError(comma); // illegal trailing comma
      }
    }
    return [items, idx + 1];
  }
}

/** `json.loads(text, ...)` as above. */
export function parseJson(text: string): JsonResult {
  const scanner = new Scanner(text);
  try {
    if (text.startsWith("﻿")) return decodeError(0); // "Unexpected UTF-8 BOM"
    const [value, end] = scanner.value(scanner.skipWs(0), 0);
    const after = scanner.skipWs(end);
    if (after !== scanner.length) return decodeError(after); // "Extra data"
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Fail) return error.result;
    throw error;
  }
}

/** `JSONDecodeError.lineno` / `colno` of a position (code points). */
export function lineColumn(text: string, pos: number): { line: number; column: number } {
  const cps = Array.from(text).slice(0, pos);
  const lastNl = cps.lastIndexOf("\n");
  return { line: cps.filter((c) => c === "\n").length + 1, column: pos - lastNl };
}
