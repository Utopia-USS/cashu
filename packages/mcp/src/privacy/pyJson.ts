/**
 * The plain JSON a redaction produces and Python's `json.dumps` of it.
 *
 * A Python int is a `bigint` here and a Python float a `number`, so the text is the same as Python's:
 * `2.0` stays `2.0`, `1e-05` stays `1e-05`, `10000000000000000.0` is `1e+16` (a JS number printed as
 * `10000000000000000` would look like an account number to the leak check). Strings are escaped as
 * `json.dumps(..., ensure_ascii=False)` escapes them.
 */

import { floatRepr } from "@cashu/domain";

export type JsonValue =
  | null
  | boolean
  | string
  | number
  | bigint
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface DumpOptions {
  /** `sort_keys=True` (code point order, as Python sorts `str`). */
  readonly sortKeys?: boolean;
  /** `separators=(",", ":")` instead of the default `(", ", ": ")`. */
  readonly compact?: boolean;
}

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
};

/** `json.dumps(s, ensure_ascii=False)` of a string. */
function pyJsonString(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters are what JSON escapes
  const escaped = s.replace(/["\\\u0000-\u001f]/g, (ch) => {
    const short = SHORT_ESCAPES[ch];
    if (short !== undefined) return short;
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `"${escaped}"`;
}

function pyFloatJson(x: number): string {
  if (Number.isNaN(x)) return "NaN";
  if (x === Number.POSITIVE_INFINITY) return "Infinity";
  if (x === Number.NEGATIVE_INFINITY) return "-Infinity";
  return floatRepr(x);
}

/** Python `str` ordering (code points), for `sort_keys`. */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0) as number;
    const cy = y.value.codePointAt(0) as number;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** `json.dumps(value, ensure_ascii=False[, sort_keys][, separators])`. */
export function pyDumps(value: JsonValue, options: DumpOptions = {}): string {
  const item = options.compact ? "," : ", ";
  const pair = options.compact ? ":" : ": ";
  const walk = (node: JsonValue): string => {
    if (node === null) return "null";
    if (typeof node === "boolean") return node ? "true" : "false";
    if (typeof node === "string") return pyJsonString(node);
    if (typeof node === "bigint") return node.toString();
    if (typeof node === "number") return pyFloatJson(node);
    if (Array.isArray(node)) return `[${node.map(walk).join(item)}]`;
    const obj = node as { readonly [key: string]: JsonValue };
    const keys = Object.keys(obj);
    if (options.sortKeys) keys.sort(compareCodePoints);
    return `{${keys.map((k) => `${pyJsonString(k)}${pair}${walk(obj[k] as JsonValue)}`).join(item)}}`;
  };
  return walk(value);
}
