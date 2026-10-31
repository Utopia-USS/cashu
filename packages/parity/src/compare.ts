import { type DecimalPolicy, decimalsEqual } from "./decimal.ts";
import { type CanonObject, type CanonValue, canonType, sha256Hex } from "./json.ts";

export interface CompareOptions {
  /** Floats are equal when `|a - b| <= absTol` or `|a - b| <= relTol * max(|a|, |b|)`. */
  absTol: number;
  relTol: number;
  decimal: DecimalPolicy;
  /** Print every object key in a path as `<key:hash>`; default prints only schema-like keys. */
  hashKeys?: boolean;
}

export const DEFAULT_OPTIONS: CompareOptions = { absTol: 1e-9, relTol: 1e-12, decimal: "exact" };

export type DiffKind =
  | "type"
  | "string"
  | "decimal"
  | "boolean"
  | "int"
  | "float"
  | "missing-key"
  | "extra-key"
  | "length"
  | "parse"
  | "rows"
  | "golden-sha";

/**
 * The first difference. `path` is a JSON path (`$.a.b[3]`); `detail` names types or lengths only.
 * Neither ever contains a value of the data.
 */
export interface Diff {
  path: string;
  kind: DiffKind;
  detail?: string;
}

const SCHEMA_KEY = /^(?:[a-z][a-z0-9_]{0,63}|\$[a-z_]{1,32}|[A-Z]{3}|\d{4}-\d{2}(?:-\d{2})?)$/;
const NATURAL_KEY = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{16}(?:~\d{1,6})?$/;

/**
 * How an object key appears in a path. Field names, `$label`, natural keys (hashed already),
 * currency codes and ISO dates are printed; any other key could be data (a merchant name used as a
 * map key), so it becomes `<key:` + the first 8 hex of its sha256 + `>`.
 */
export function pathKey(key: string, hashAll = false): string {
  if (!hashAll && (SCHEMA_KEY.test(key) || NATURAL_KEY.test(key))) return key;
  return `<key:${sha256Hex(key).slice(0, 8)}>`;
}

function renderPath(segments: readonly (string | number)[], hashKeys: boolean): string {
  let out = "$";
  for (const s of segments) {
    out += typeof s === "number" ? `[${s}]` : `.${pathKey(s, hashKeys)}`;
  }
  return out;
}

export function floatsEqual(a: number, b: number, absTol: number, relTol: number): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= absTol || diff <= relTol * Math.max(Math.abs(a), Math.abs(b));
}

function numbersEqual(a: bigint | number, b: bigint | number, o: CompareOptions): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  // Integer against float: a TS producer cannot tell `1` from `1.0`, so compare as numbers.
  return floatsEqual(Number(a), Number(b), o.absTol, o.relTol);
}

class Walker {
  private readonly segments: (string | number)[] = [];

  private readonly o: CompareOptions;

  constructor(o: CompareOptions) {
    this.o = o;
  }

  find(golden: CanonValue, actual: CanonValue): Diff | null {
    return this.walk(golden, actual);
  }

  private diff(kind: DiffKind, detail?: string): Diff {
    const d: Diff = { path: renderPath(this.segments, this.o.hashKeys === true), kind };
    if (detail !== undefined) d.detail = detail;
    return d;
  }

  private walk(g: CanonValue, a: CanonValue): Diff | null {
    const gt = canonType(g);
    const at = canonType(a);
    const gNum = gt === "int" || gt === "float";
    const aNum = at === "int" || at === "float";
    if (gNum && aNum) {
      return numbersEqual(g as bigint | number, a as bigint | number, this.o)
        ? null
        : this.diff(gt === "int" && at === "int" ? "int" : "float");
    }
    if (gt !== at) return this.diff("type", `${gt} vs ${at}`);
    switch (gt) {
      case "null":
        return null;
      case "boolean":
        return g === a ? null : this.diff("boolean");
      case "string":
        return this.strings(g as string, a as string);
      case "array":
        return this.arrays(g as CanonValue[], a as CanonValue[]);
      case "object":
        return this.objects(g as CanonObject, a as CanonObject);
      default:
        return null;
    }
  }

  private strings(g: string, a: string): Diff | null {
    if (g === a) return null;
    if (this.o.decimal === "numeric" && decimalsEqual(g, a)) return null;
    return this.diff("string");
  }

  private arrays(g: CanonValue[], a: CanonValue[]): Diff | null {
    const n = Math.min(g.length, a.length);
    for (let i = 0; i < n; i++) {
      this.segments.push(i);
      const found = this.walk(g[i] as CanonValue, a[i] as CanonValue);
      if (found !== null) return found;
      this.segments.pop();
    }
    return g.length === a.length ? null : this.diff("length", `${g.length} vs ${a.length}`);
  }

  private objects(g: CanonObject, a: CanonObject): Diff | null {
    const keys = [...new Set([...g.keys(), ...a.keys()])].sort();
    for (const key of keys) {
      this.segments.push(key);
      const gv = g.get(key);
      const av = a.get(key);
      if (gv === undefined) return this.diff("extra-key");
      if (av === undefined) return this.diff("missing-key");
      const found = this.walk(gv, av);
      if (found !== null) return found;
      this.segments.pop();
    }
    return null;
  }
}

/**
 * Compare a golden tree to an actual one. Objects are unordered (key order never matters), arrays
 * are ordered. Returns the first difference in sorted-key, index order, or `null` when equal.
 */
export function compare(
  golden: CanonValue,
  actual: CanonValue,
  options: CompareOptions = DEFAULT_OPTIONS,
): Diff | null {
  return new Walker(options).find(golden, actual);
}
