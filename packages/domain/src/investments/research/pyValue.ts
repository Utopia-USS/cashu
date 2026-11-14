/**
 * Python views of decoded JSON values for validation: type checks (`isinstance(x, int)` without
 * `bool`, `Mapping`), truthiness and `str(x)`.
 *
 * JSON decoding loses two distinctions Python keeps: `2.0` arrives as the number 2 (Python: a float,
 * refused where an int is required) and integers beyond 2^53 lose precision. Inputs come from MCP
 * JSON arguments, so the TS port accepts `2.0` as an integer there.
 */

import { floatRepr } from "../../decimal.js";
import { pyReprStr } from "../../pyRepr.js";

export type JsonObject = Readonly<Record<string, unknown>>;

/** `isinstance(value, Mapping)` for a decoded JSON value. */
export function isMapping(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `isinstance(value, int) and not isinstance(value, bool)`. */
export function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

/** `isinstance(value, int | float) and not isinstance(value, bool)`. */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** Python `str` ordering (by code point; JavaScript's default sort compares UTF-16 units). */
function compareCodePoints(a: string, b: string): number {
  const pa = Array.from(a, (c) => c.codePointAt(0) as number);
  const pb = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    const d = (pa[i] as number) - (pb[i] as number);
    if (d !== 0) return d;
  }
  return pa.length - pb.length;
}

/** Own keys of a mapping not in `allowed`, sorted by code point like Python `sorted(set(...))`. */
export function unknownKeys(value: JsonObject, allowed: readonly string[]): string[] {
  return Object.keys(value)
    .filter((k) => !allowed.includes(k))
    .sort(compareCodePoints);
}

/** `mapping.get(key)` (own properties only; a missing key is undefined like Python's None). */
export function get(value: JsonObject, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** Python `None` for a decoded JSON value: null or a missing key. */
export function isNone(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

/** Python truthiness of a decoded JSON value. */
export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isMapping(value)) return Object.keys(value).length > 0;
  return !!value;
}

function repr(value: unknown): string {
  if (typeof value === "string") return pyReprStr(value);
  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (isMapping(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyReprStr(k)}: ${repr(v)}`)
      .join(", ")}}`;
  }
  return pyStr(value);
}

/** Python `str(value)` of a decoded JSON value (`True`, `5`, `1.5`, `None`, `[1, 'a']`). */
export function pyStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number")
    return Number.isInteger(value) ? BigInt(value).toString() : floatRepr(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || value === undefined) return "None";
  return repr(value);
}
