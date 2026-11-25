/**
 * Static checks of a parsed expression against the metric catalog (`rules/expr/checker.py`): names,
 * scopes, argument literals, types. Produces a `CompiledExpression` the evaluator can run without
 * further checks.
 */

import { pyLower, pyStrip } from "../../../text.js";
import { InvariantError } from "../../domain/values.js";
import { didYouMean } from "../hints.js";
import { METRICS, namesInScope } from "./catalog.js";
import {
  type ArgSpec,
  isFunction,
  type MetricSpec,
  parseScope,
  SCOPES,
  type Scope,
  signature,
  ValueType,
} from "./catalogTypes.js";
import { type CompiledExpression, type MetricRef, metricLabel, specOf } from "./compiled.js";
import { ExpressionError, KEYWORDS } from "./lexer.js";
import { MAX_FUNCTION_ARGS } from "./limits.js";
import type { CallNode, CompareNode, ExprNode, NameNode } from "./nodes.js";
import { parse } from "./parser.js";

/**
 * Parses and type-checks `source` for `scope`. Throws `ExpressionError` (1-based column), or
 * `PyValueError` for an unknown scope (checked first, as Python's `Scope(scope)`).
 */
export function compileExpression(source: string, scope: Scope | string): CompiledExpression {
  const checkedScope = parseScope(scope);
  // Python fails on `len(None)` with a TypeError; keep untyped callers from reaching the lexer.
  if (typeof source !== "string") throw new TypeError("expression source must be a string");
  const tree = parse(source);
  const checker = new Checker(checkedScope);
  const result = checker.typeOf(tree);
  if (result !== ValueType.BOOLEAN) {
    throw new ExpressionError(
      "The expression must be a condition (true or false), e.g. weight > 10%; " +
        `this one gives ${article(result)}`,
      tree.column,
    );
  }
  if (checker.refs.size === 0) {
    throw new ExpressionError(
      "The expression uses no metric, so it would always give the same answer",
      tree.column,
    );
  }
  return { source, scope: checkedScope, tree, metrics: [...checker.refs.values()] };
}

class Checker {
  readonly refs = new Map<string, MetricRef>();
  private readonly scope: Scope;

  constructor(scope: Scope) {
    this.scope = scope;
  }

  // Recursion depth is the tree depth, which `parse` bounds by MAX_DEPTH.
  typeOf(node: ExprNode): ValueType {
    switch (node.type) {
      case "Number":
        return ValueType.NUMBER;
      case "String":
        return ValueType.TEXT;
      case "Boolean":
        return ValueType.BOOLEAN;
      case "Name":
        return this.name(node);
      case "Call":
        return this.call(node);
      case "Unary":
        if (node.op === "not") {
          this.expect(node.operand, ValueType.BOOLEAN, "'not' needs a condition");
          return ValueType.BOOLEAN;
        }
        this.expect(node.operand, ValueType.NUMBER, `'${node.op}' needs a number`);
        return ValueType.NUMBER;
      case "Binary":
        this.expect(node.left, ValueType.NUMBER, `'${node.op}' needs numbers on both sides`);
        this.expect(node.right, ValueType.NUMBER, `'${node.op}' needs numbers on both sides`);
        return ValueType.NUMBER;
      case "Compare":
        return this.compare(node);
      case "Logical":
        for (const operand of node.operands) {
          this.expect(operand, ValueType.BOOLEAN, `'${node.op}' needs conditions on both sides`);
        }
        return ValueType.BOOLEAN;
      default:
        return assertNever(node);
    }
  }

  private expect(node: ExprNode, expected: ValueType, message: string): void {
    const actual = this.typeOf(node);
    if (actual !== expected) {
      throw new ExpressionError(`${message}; ${show(node)} is ${article(actual)}`, node.column);
    }
  }

  private lookup(name: string, column: number): MetricSpec {
    const lower = pyLower(name);
    if (KEYWORDS.has(lower)) throw new ExpressionError(`Write "${lower}" in lowercase`, column);
    const spec = METRICS.get(name);
    if (spec === undefined) {
      const known = [...namesInScope(this.scope), ...[...KEYWORDS].sort()];
      throw new ExpressionError(
        `Unknown name "${name}"${didYouMean(name, known)}; see the metric catalog for scope ${this.scope}`,
        column,
      );
    }
    if (!spec.scopes.has(this.scope)) {
      const available = SCOPES.filter((scope) => spec.scopes.has(scope)).join(", ");
      throw new ExpressionError(
        `${name} is not available in scope ${this.scope} (available in: ${available})`,
        column,
      );
    }
    return spec;
  }

  private name(node: NameNode): ValueType {
    const spec = this.lookup(node.name, node.column);
    if (isFunction(spec)) {
      throw new ExpressionError(
        `${node.name} is a function; call it with arguments: ${signature(spec)}`,
        node.column,
      );
    }
    this.record({ name: node.name, args: [], column: node.column });
    return spec.type;
  }

  private call(node: CallNode): ValueType {
    const spec = this.lookup(node.name, node.column);
    const specArgs = spec.args;
    if (specArgs === null) {
      throw new ExpressionError(
        `${node.name} is not a function; write it without parentheses`,
        node.column,
      );
    }
    const variadic = specArgs.length > 0 && specArgs[specArgs.length - 1]?.variadic === true;
    const fixed = specArgs.length - (variadic ? 1 : 0);
    const count = node.args.length;
    if ((!variadic && count !== specArgs.length) || (variadic && count < specArgs.length)) {
      throw new ExpressionError(
        `${node.name} takes ${arity(spec)}; usage: ${signature(spec)}`,
        node.column,
      );
    }
    if (count > MAX_FUNCTION_ARGS) {
      // Unreachable: the parser enforces the limit first (kept as Python does).
      throw new ExpressionError(`Too many arguments for ${node.name}`, node.column);
    }
    const values = node.args.map((argNode, index) => {
      const argSpec = specArgs[variadic ? Math.min(index, fixed) : index];
      if (argSpec === undefined) throw new InvariantError("argument without a spec");
      return this.literalArg(node.name, argSpec, argNode);
    });
    if (variadic) {
      // Python `len(set(values[fixed:]))`: an int never equals a str, so key by type and value.
      const repeated = values.slice(fixed);
      const distinct = new Set(repeated.map((value) => `${typeof value}:${value}`));
      if (distinct.size !== repeated.length) {
        throw new ExpressionError(`${node.name} lists the same value twice`, node.column);
      }
    }
    this.record({ name: node.name, args: values, column: node.column });
    return spec.type;
  }

  private literalArg(fn: string, spec: ArgSpec, node: ExprNode): number | string {
    if (spec.type === ValueType.NUMBER) {
      if (node.type !== "Number" || node.text.endsWith("%")) {
        throw new ExpressionError(
          `${spec.name} of ${fn} must be a whole number${rangeText(spec)}, written as a literal`,
          node.column,
        );
      }
      const value = node.value;
      if (!value.eq(value.toIntegralValue())) {
        throw new ExpressionError(
          `${spec.name} of ${fn} must be a whole number, got ${node.text}`,
          node.column,
        );
      }
      // Python `int(value)`: exact (a literal has at most 24 digits), compared before narrowing.
      const whole = value.toBigInt();
      if (
        (spec.minimum !== null && whole < BigInt(spec.minimum)) ||
        (spec.maximum !== null && whole > BigInt(spec.maximum))
      ) {
        throw new ExpressionError(
          `${spec.name} of ${fn} must be${rangeText(spec)}, got ${whole}`,
          node.column,
        );
      }
      return Number(whole);
    }
    if (node.type !== "String") {
      throw new ExpressionError(
        `${spec.name} of ${fn} must be text in quotes, e.g. ${fn}("x")`,
        node.column,
      );
    }
    const text = pyStrip(node.value);
    if (!text) throw new ExpressionError(`${spec.name} of ${fn} must not be empty`, node.column);
    if (spec.choices !== null && !spec.choices.includes(text)) {
      throw new ExpressionError(
        `Unknown ${spec.name} "${text}"${didYouMean(text, spec.choices)}; ` +
          `known: ${spec.choices.join(", ")}`,
        node.column,
      );
    }
    return text;
  }

  private compare(node: CompareNode): ValueType {
    const left = this.typeOf(node.left);
    const right = this.typeOf(node.right);
    if (node.op === "==" || node.op === "!=") {
      if (left !== right) {
        throw new ExpressionError(
          `'${node.op}' compares values of the same type; ${show(node.left)} is ` +
            `${article(left)}, ${show(node.right)} is ${article(right)}`,
          node.column,
        );
      }
      if (left === ValueType.TEXT) {
        checkChoice(node.left, node.right);
        checkChoice(node.right, node.left);
      }
      return ValueType.BOOLEAN;
    }
    for (const [side, sideType] of [
      [node.left, left],
      [node.right, right],
    ] as const) {
      if (sideType !== ValueType.NUMBER) {
        throw new ExpressionError(
          `'${node.op}' compares numbers; ${show(side)} is ${article(sideType)}`,
          side.column,
        );
      }
    }
    return ValueType.BOOLEAN;
  }

  private record(ref: MetricRef): void {
    const label = metricLabel(ref);
    if (!this.refs.has(label)) this.refs.set(label, ref);
  }
}

function checkChoice(variable: ExprNode, literal: ExprNode): void {
  if (variable.type !== "Name" || literal.type !== "String") return;
  const choices = specOf(variable.name).choices;
  if (choices !== null && !choices.includes(literal.value)) {
    throw new ExpressionError(
      `${variable.name} is never "${literal.value}"${didYouMean(literal.value, choices)}; ` +
        `known: ${choices.join(", ")}`,
      literal.column,
    );
  }
}

function arity(spec: MetricSpec): string {
  const args = spec.args ?? [];
  if (args[args.length - 1]?.variadic) return `at least ${args.length} argument(s)`;
  if (args.length === 0) return "no arguments";
  return `${args.length} argument(s)`;
}

function rangeText(spec: ArgSpec): string {
  if (spec.minimum !== null && spec.maximum !== null) {
    return ` between ${spec.minimum} and ${spec.maximum}`;
  }
  if (spec.minimum !== null) return ` of at least ${spec.minimum}`;
  return "";
}

function article(valueType: ValueType): string {
  switch (valueType) {
    case ValueType.NUMBER:
      return "a number";
    case ValueType.BOOLEAN:
      return "a condition (true/false)";
    case ValueType.TEXT:
      return "text";
    default:
      return assertNever(valueType);
  }
}

function show(node: ExprNode): string {
  switch (node.type) {
    case "Name":
    case "Call":
      return node.name;
    case "Number":
      return node.text;
    case "String":
      return `"${node.value}"`;
    case "Boolean":
      return node.value ? "true" : "false";
    default:
      return `the part at column ${node.column}`;
  }
}

function assertNever(value: never): never {
  throw new InvariantError(`unexpected value ${JSON.stringify(value)}`);
}
