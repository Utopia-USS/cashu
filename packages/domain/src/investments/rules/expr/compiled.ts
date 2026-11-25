/**
 * The result of compiling an expression (`rules/expr/checker.py`: `MetricRef`, `CompiledExpression`)
 * and the Python properties of both as functions.
 */

import { pySplit } from "../../../text.js";
import { InvariantError } from "../../domain/values.js";
import { METRICS } from "./catalog.js";
import { type ArgSpec, isFunction, type MetricSpec, type Scope } from "./catalogTypes.js";
import type { ExprNode } from "./nodes.js";

/** One metric use: a variable (`args` empty) or a function call with literal arguments. */
export interface MetricRef {
  readonly name: string;
  readonly args: readonly (number | string)[];
  readonly column: number;
}

/** A checked expression of one scope. Build it with `compileExpression`. */
export interface CompiledExpression {
  readonly source: string;
  readonly scope: Scope;
  readonly tree: ExprNode;
  /** Metric uses in order of first appearance, one per distinct label. */
  readonly metrics: readonly MetricRef[];
}

export function specOf(name: string): MetricSpec {
  const spec = METRICS.get(name);
  if (spec === undefined) throw new InvariantError(`unknown metric ${name}`);
  return spec;
}

/** Python `MetricRef.label`: the stable text form used as the payload key, e.g. `drawdown_from_high(252)`. */
export function metricLabel(ref: MetricRef): string {
  if (!isFunction(specOf(ref.name))) return ref.name;
  const rendered = ref.args.map((arg) => (typeof arg === "string" ? `"${arg}"` : String(arg)));
  return `${ref.name}(${rendered.join(", ")})`;
}

/** Python `CompiledExpression.bucket_references`: (bucket id, column) of every literal naming a bucket. */
export function bucketReferences(expr: CompiledExpression): [string, number][] {
  const refs: [string, number][] = [];
  for (const ref of expr.metrics) {
    const spec = specOf(ref.name);
    if (!isFunction(spec)) continue;
    const argSpecs = expandArgs(spec, ref.args.length);
    ref.args.forEach((value, index) => {
      if (argSpecs[index]?.reference === "bucket" && typeof value === "string") {
        refs.push([value, ref.column]);
      }
    });
  }
  return refs;
}

/** Python `CompiledExpression.normalized`: the source with runs of whitespace collapsed. */
export function normalized(expr: CompiledExpression): string {
  return pySplit(expr.source).join(" ");
}

/** Python `_expand`: the arg spec of each of `count` arguments (the variadic one repeated). */
function expandArgs(spec: MetricSpec, count: number): readonly ArgSpec[] {
  const args = spec.args ?? [];
  const last = args[args.length - 1];
  if (last?.variadic) {
    const fixed = args.slice(0, -1);
    return [...fixed, ...Array.from({ length: count - fixed.length }, () => last)];
  }
  return args;
}
