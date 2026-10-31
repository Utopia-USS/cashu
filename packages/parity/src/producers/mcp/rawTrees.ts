/**
 * The S02 raw labelled trees (`mcp.read_raw`) back as TS labelled trees, and the redacted result as
 * the canonical tree Python's `canon.py` writes. `canon.py` erased some Python types on the way to
 * JSON; this adapter restores them where the redactor's behaviour depends on them and refuses the
 * cases it cannot decide (an `AdapterError` fails the check instead of guessing):
 *
 * - integer row ids under id fields became natural keys: under a `ref` label (the only label the
 *   goldens carry them under) each key becomes a small synthetic int (a valid `\d{1,12}` ref like any
 *   row id) and is mapped back after redaction; under any other label: refused;
 * - NaN / Infinity floats became strings: under `percent` / `level` / `amount` they are floats again;
 *   any other string there was a Decimal (Python's redactor accepts nothing else) and becomes one;
 * - naive datetimes and strings look alike: a `date` string with a time part must carry `+00:00`
 *   (then datetime and string redact to the same text); a naive or non-UTC one is refused.
 */

import { D } from "@cashu/domain";
import {
  Labelled,
  type LabelledTree,
  type LeafValue,
  SENSITIVITIES,
  type Sensitivity,
} from "@cashu/mcp";
import type { CanonObject, CanonValue } from "../../json.ts";
import { type OutValue, PyFloat } from "../output.ts";

export class AdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdapterError";
  }
}

/**
 * Synthetic ids are 1, 2, 3...: small like the row ids they stand for, so the leak check (10+ digit
 * runs) sees the same thing; the goldens hold no raw ints under id fields to collide with (checked).
 */
const SYNTHETIC_START = 1n;
const NATURAL_KEY = /^[a-z][a-z0-9_-]*:(?:[0-9a-f]{16}(?:~\d+)?|dangling-\d+)$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const NUMERIC: ReadonlySet<Sensitivity> = new Set(["percent", "level", "amount"]);

/** `canon._is_id_field`. */
function isIdField(name: string | null): boolean {
  return name !== null && (name === "id" || name.endsWith("_id") || name.endsWith("_ids"));
}

export class SyntheticIds {
  private readonly byKey = new Map<string, bigint>();
  private readonly byId = new Map<bigint, string>();

  id(key: string): bigint {
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = SYNTHETIC_START + BigInt(this.byKey.size);
      this.byKey.set(key, id);
      this.byId.set(id, key);
    }
    return id;
  }

  key(id: bigint): string | undefined {
    return this.byId.get(id);
  }
}

function isLabelObject(node: CanonObject): boolean {
  return node.size === 2 && node.has("$label") && node.has("value");
}

function leafValue(
  raw: CanonValue,
  label: Sensitivity,
  field: string | null,
  ids: SyntheticIds,
): LeafValue {
  if (
    raw === null ||
    typeof raw === "boolean" ||
    typeof raw === "bigint" ||
    typeof raw === "number"
  ) {
    if (typeof raw === "bigint" && isIdField(field)) {
      throw new AdapterError("a raw int under an id field (canon.py maps every one)");
    }
    return raw;
  }
  if (typeof raw !== "string") throw new AdapterError("a labelled value that is not a scalar");
  if (isIdField(field) && NATURAL_KEY.test(raw)) {
    if (label !== "ref") throw new AdapterError(`a natural key under a ${label} label`);
    return ids.id(raw);
  }
  if (NUMERIC.has(label)) {
    if (raw === "NaN") return Number.NaN;
    if (raw === "Infinity") return Number.POSITIVE_INFINITY;
    if (raw === "-Infinity") return Number.NEGATIVE_INFINITY;
    return D(raw); // Python kept a Decimal there (str() in the golden)
  }
  if (label === "date" && DATE_TIME.test(raw) && !raw.endsWith("+00:00")) {
    throw new AdapterError("a naive or non-UTC timestamp: datetime and string redact differently");
  }
  return raw;
}

/** A raw golden tree as the labelled tree the handler returned. */
export function toLabelledTree(
  raw: CanonValue,
  ids: SyntheticIds,
  field: string | null = null,
): LabelledTree {
  if (raw === null) return null;
  if (Array.isArray(raw)) return raw.map((v) => toLabelledTree(v, ids, field));
  if (raw instanceof Map) {
    if (isLabelObject(raw)) {
      const label = raw.get("$label");
      if (typeof label !== "string" || !(SENSITIVITIES as readonly string[]).includes(label)) {
        throw new AdapterError("an unknown label");
      }
      return new Labelled(
        leafValue(raw.get("value") ?? null, label as Sensitivity, field, ids),
        label as Sensitivity,
      );
    }
    const out: Record<string, LabelledTree> = {};
    for (const [key, value] of raw) {
      Object.defineProperty(out, key, {
        value: toLabelledTree(value, ids, key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  throw new AdapterError("an unlabelled scalar in a raw tree");
}

type Redacted =
  | null
  | boolean
  | string
  | number
  | bigint
  | readonly Redacted[]
  | { readonly [key: string]: Redacted };

/** The redacted tree as canon.py writes it: floats as Python floats, synthetic ids as their keys. */
export function toCanonical(
  value: Redacted,
  ids: SyntheticIds,
  field: string | null = null,
): OutValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return new PyFloat(value);
  if (typeof value === "bigint") {
    if (!isIdField(field)) return value;
    const key = ids.key(value);
    if (key === undefined)
      throw new AdapterError("an int under an id field that canon.py would map");
    return key;
  }
  if (typeof value === "string") {
    if (isIdField(field) && /^[1-9]\d*$/.test(value)) {
      throw new AdapterError("a digit string under an id field that canon.py would map");
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => toCanonical(v, ids, field));
  const out: Record<string, OutValue> = {};
  for (const key of Object.keys(value)) {
    Object.defineProperty(out, key, {
      value: toCanonical((value as Record<string, Redacted>)[key] as Redacted, ids, key),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

/** A plain JSON copy of a canonical value (for entries passed through unchanged). */
export function canonToOut(value: CanonValue): OutValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "number") return new PyFloat(value);
  if (Array.isArray(value)) return value.map(canonToOut);
  const out: Record<string, OutValue> = {};
  for (const [k, v] of value) {
    Object.defineProperty(out, k, {
      value: canonToOut(v),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}
