/**
 * The performance service views (`@cashu/domain` `performanceView` / `attributionView`) in the
 * golden's canonical form: Python ints as integers, every other number as a Python float, instrument
 * and account ids as dataset keys. The views are plain JSON (numbers, strings, booleans, null), so
 * this walks them by key: the keys below are the only ones whose numbers Python writes as `int`.
 */

import { type OutValue, pyFloat } from "../output.ts";
import type { Serializer } from "./serialize.ts";

/** Keys whose numbers are Python ints in `performance_view` / `attribution_view`. */
const INT_KEYS: ReadonlySet<string> = new Set([
  "days",
  "incomplete_days",
  "unknown_flows",
  "price_mismatches",
  "windows",
  "months",
  "n",
  "instruments",
  "flows",
  "positive_instruments",
  "negative_instruments",
  "unvalued_instruments",
  "unknown_cash",
]);

function walk(value: unknown, key: string, s: Serializer): OutValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (key === "instrument_id") return s.instrumentKey(value);
    if (key === "account_id" || key === "accounts_filter") return s.account(value);
    return value;
  }
  if (typeof value === "number") {
    if (!INT_KEYS.has(key)) return pyFloat(value);
    if (!Number.isInteger(value)) throw new Error(`${key}: a Python int that is not an integer`);
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map((item) => walk(item, key, s));
  if (typeof value === "object") {
    const out: Record<string, OutValue> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walk(v, k, s);
    return out;
  }
  throw new Error(`${key}: not a JSON value`);
}

/** A performance or attribution view as the golden writes it. */
export function performanceOut(view: object, s: Serializer): OutValue {
  return walk(view, "", s);
}
