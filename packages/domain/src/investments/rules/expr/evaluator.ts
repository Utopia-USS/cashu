// Python rules/expr/evaluator.py: bounded Decimal arithmetic and eager Kleene logic.
import type { UiLang } from "../../../core/i18n.js";
import { Decimal, DecimalError, localContext, makeContext } from "../../../decimal.js";
import { pyStrip } from "../../../text.js";
import { type CompiledExpression, type MetricRef, metricLabel } from "./compiled.js";
import { evaluationReason } from "./evaluator.strings.js";
import { COMPARISON_TOLERANCE } from "./limits.js";
import type { BinaryNode, CallNode, CompareNode, ExprNode } from "./nodes.js";

export class Unknown {
  readonly reasons: readonly string[];
  constructor(reasons: readonly string[]) {
    this.reasons = Object.freeze([...reasons]);
    Object.freeze(this);
  }
}

export type Value = Decimal | boolean | string | Unknown;
export type MetricResolver = (ref: MetricRef) => Value;
export interface Evaluation {
  readonly result: boolean | null;
  readonly reasons: readonly string[];
  readonly values: ReadonlyMap<string, Value>;
}

const CONTEXT = makeContext({ prec: 28, Emax: 999_999, Emin: -999_999 });

/** Resolves every compiled metric once, before entering the evaluator's local decimal context. */
export function evaluateExpression(
  expression: CompiledExpression,
  resolve: MetricResolver,
  lang: UiLang = "en",
): Evaluation {
  const values = new Map<string, Value>();
  for (const ref of expression.metrics) {
    const label = metricLabel(ref);
    const value = resolve(ref);
    if (typeof value === "number") throw new TypeError(`resolver returned a float for ${label}`);
    values.set(label, value);
  }
  const result = localContext(CONTEXT, () => new Evaluator(values, lang).evaluate(expression.tree));
  if (result instanceof Unknown)
    return { result: null, reasons: [...new Set(result.reasons)], values };
  if (typeof result !== "boolean") throw new TypeError("expression result must be a boolean");
  return { result, reasons: [], values };
}

function mergeUnknown(values: readonly Value[]): Unknown | undefined {
  const unknowns = values.filter((value): value is Unknown => value instanceof Unknown);
  return unknowns.length === 0
    ? undefined
    : new Unknown(unknowns.flatMap((value) => value.reasons));
}

function decimal(value: Value): Decimal {
  if (!(value instanceof Decimal)) throw new TypeError("expected a decimal operand");
  return value;
}

function callLabel(node: CallNode): string {
  const args = node.args.map((arg) => {
    if (arg.type === "String") return `"${pyStrip(arg.value)}"`;
    if (arg.type === "Number") return String(arg.value.toBigInt());
    throw new TypeError("compiled metric argument must be a literal");
  });
  return `${node.name}(${args.join(", ")})`;
}

class Evaluator {
  private readonly values: ReadonlyMap<string, Value>;
  private readonly lang: UiLang;
  constructor(values: ReadonlyMap<string, Value>, lang: UiLang) {
    this.values = values;
    this.lang = lang;
  }

  private metric(label: string): Value {
    const value = this.values.get(label);
    if (value === undefined) throw new TypeError(`unresolved metric ${label}`);
    return value;
  }

  evaluate(node: ExprNode): Value {
    switch (node.type) {
      case "Number":
      case "String":
      case "Boolean":
        return node.value;
      case "Name":
        return this.metric(node.name);
      case "Call":
        return this.metric(callLabel(node));
      case "Unary": {
        const value = this.evaluate(node.operand);
        if (value instanceof Unknown) return value;
        if (node.op === "not") return value instanceof Decimal ? value.isZero() : !value;
        return node.op === "-" ? decimal(value).neg() : decimal(value).plus();
      }
      case "Binary":
        return this.binary(node);
      case "Compare":
        return this.compare(node);
      case "Logical": {
        // Evaluate all operands, including those made irrelevant by a decisive truth value.
        const values = node.operands.map((operand) => this.evaluate(operand));
        const decisive = node.op === "or";
        if (values.some((value) => value === decisive)) return decisive;
        return mergeUnknown(values) ?? !decisive;
      }
    }
  }

  private binary(node: BinaryNode): Value {
    const a = this.evaluate(node.left);
    const b = this.evaluate(node.right);
    const unknown = mergeUnknown([a, b]);
    if (unknown !== undefined) return unknown;
    const left = decimal(a);
    const right = decimal(b);
    try {
      switch (node.op) {
        case "+":
          return left.add(right);
        case "-":
          return left.sub(right);
        case "*":
          return left.mul(right);
        default:
          return right.isZero()
            ? new Unknown([evaluationReason.divisionByZero(this.lang, node.column)])
            : left.div(right);
      }
    } catch (error) {
      if (!(error instanceof DecimalError)) throw error;
      if (error.signal === "Overflow")
        return new Unknown([evaluationReason.overflow(this.lang, node.column)]);
      if (error.signal === "InvalidOperation" || error.signal === "DivisionByZero")
        return new Unknown([evaluationReason.invalid(this.lang, node.column)]);
      throw error;
    }
  }

  private compare(node: CompareNode): Value {
    const left = this.evaluate(node.left);
    const right = this.evaluate(node.right);
    const unknown = mergeUnknown([left, right]);
    if (unknown !== undefined) return unknown;
    if (left instanceof Decimal && right instanceof Decimal) {
      const difference = left.sub(right);
      const tolerance = COMPARISON_TOLERANCE;
      switch (node.op) {
        case "<":
          return difference.lt(tolerance.neg());
        case "<=":
          return difference.lte(tolerance);
        case ">":
          return difference.gt(tolerance);
        case ">=":
          return difference.gte(tolerance.neg());
        case "==":
          return difference.abs().lte(tolerance);
        default:
          return difference.abs().gt(tolerance);
      }
    }
    // Python bool is numeric for equality, even if a resolver supplies a value of the wrong type.
    const equal =
      left instanceof Decimal && typeof right === "boolean"
        ? left.eq(Decimal.fromInt(right ? 1 : 0))
        : right instanceof Decimal && typeof left === "boolean"
          ? right.eq(Decimal.fromInt(left ? 1 : 0))
          : left === right;
    return node.op === "==" ? equal : !equal;
  }
}
