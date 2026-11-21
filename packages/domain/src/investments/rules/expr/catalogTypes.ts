/**
 * Types of the metric catalog of custom-rule expressions (`rules/expr/catalog.py`): scopes, value
 * types, units, argument and metric specs. The specs themselves live in `catalog.ts`.
 */

import { PyValueError } from "../../../dates.js";
import { pyReprStr } from "../../../pyRepr.js";

type Values<T> = T[keyof T];

/** What one evaluation of a custom rule looks at (`params.scope`). */
export const Scope = Object.freeze({
  /** Once for the whole portfolio (one signal per rule). */
  PORTFOLIO: "portfolio",
  /** Once per held instrument, summed across accounts (one signal per instrument). */
  INSTRUMENT: "instrument",
  /** Once per strategy bucket (one signal per bucket). */
  BUCKET: "bucket",
} as const);
export type Scope = Values<typeof Scope>;
/** Every scope in declaration order (Python `list(Scope)`). */
export const SCOPES: readonly Scope[] = Object.freeze(Object.values(Scope));

/** Python `Scope(value)`: throws `PyValueError` ("'x' is not a valid Scope") for an unknown value. */
export function parseScope(value: string): Scope {
  const found = SCOPES.find((scope) => scope === value);
  if (found === undefined) throw new PyValueError(`${pyReprStr(value)} is not a valid Scope`);
  return found;
}

export const ValueType = Object.freeze({
  NUMBER: "number",
  BOOLEAN: "boolean",
  TEXT: "text",
} as const);
export type ValueType = Values<typeof ValueType>;

/** How a numeric metric is shown in messages. */
export const Unit = Object.freeze({
  /** A fraction shown as a percentage (0.153 -> 15,3 %). */
  RATIO: "ratio",
  /** Percentage points (2.5 -> 2,5 pp). */
  PP: "pp",
  /** Base-currency amount (shown in whole units). */
  AMOUNT: "amount",
  /** A price in the instrument's currency. */
  PRICE: "price",
  DAYS: "days",
  COUNT: "count",
  TEXT: "text",
  FLAG: "flag",
} as const);
export type Unit = Values<typeof Unit>;

/** One argument of a metric function. Arguments must be literals. */
export interface ArgSpec {
  readonly name: string;
  readonly type: ValueType;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly choices: readonly string[] | null;
  /** `bucket` when the argument names a strategy bucket (cross-checked by the strategy loader). */
  readonly reference: string | null;
  /** The last argument may repeat (1 to MAX_FUNCTION_ARGS values). */
  readonly variadic: boolean;
}

export interface MetricSpec {
  readonly name: string;
  readonly type: ValueType;
  readonly unit: Unit;
  readonly scopes: ReadonlySet<Scope>;
  readonly doc: string;
  /** null for a variable; an array (possibly empty) for a function. */
  readonly args: readonly ArgSpec[] | null;
  /** Allowed values of a TEXT variable (literals compared with it are checked against them). */
  readonly choices: readonly string[] | null;
}

/** Python `MetricSpec.is_function`. */
export function isFunction(spec: MetricSpec): boolean {
  return spec.args !== null;
}

/** Python `MetricSpec.signature()`: `name` or `name(arg, tag, ...)`. */
export function signature(spec: MetricSpec): string {
  if (spec.args === null) return spec.name;
  const parts = spec.args.map((arg) => (arg.variadic ? `${arg.name}, ...` : arg.name));
  return `${spec.name}(${parts.join(", ")})`;
}
