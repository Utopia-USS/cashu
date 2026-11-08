// The canonical JSON of the retired Python vectors_inv_rules_expr.py, built from the TS port: trees with
// the Python dataclass field names in declaration order, Decimals as `str(Decimal)`, errors as
// [message, column, str(error)]. Test-only.

import { PyValueError } from "../../../../dates.js";
import { METRICS } from "../catalog.js";
import { SCOPES, type Scope } from "../catalogTypes.js";
import { compileExpression } from "../checker.js";
import { bucketReferences, metricLabel, normalized } from "../compiled.js";
import { ExpressionError, tokenize } from "../lexer.js";
import type { ExprNode } from "../nodes.js";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

function nodeOut(node: ExprNode): Json {
  switch (node.type) {
    case "Number":
      return {
        type: node.type,
        value: node.value.toString(),
        text: node.text,
        column: node.column,
      };
    case "String":
    case "Boolean":
      return { type: node.type, value: node.value, column: node.column };
    case "Name":
      return { type: node.type, name: node.name, column: node.column };
    case "Call":
      return {
        type: node.type,
        name: node.name,
        args: node.args.map(nodeOut),
        column: node.column,
      };
    case "Unary":
      return { type: node.type, op: node.op, operand: nodeOut(node.operand), column: node.column };
    case "Binary":
    case "Compare":
      return {
        type: node.type,
        op: node.op,
        left: nodeOut(node.left),
        right: nodeOut(node.right),
        column: node.column,
      };
    case "Logical":
      return {
        type: node.type,
        op: node.op,
        operands: node.operands.map(nodeOut),
        column: node.column,
      };
  }
}

function errorOut(error: unknown): Json {
  if (error instanceof ExpressionError) {
    return { error: [error.message, error.column, error.toString()] };
  }
  if (error instanceof PyValueError) return { value_error: error.message };
  throw error;
}

export function compileOut(source: string, scope: Scope | string): Json {
  try {
    const compiled = compileExpression(source, scope);
    return {
      ok: {
        tree: nodeOut(compiled.tree),
        metrics: compiled.metrics.map((ref) => [ref.name, ref.args, ref.column, metricLabel(ref)]),
        bucket_references: bucketReferences(compiled),
        normalized: normalized(compiled),
      },
    };
  } catch (error) {
    return errorOut(error);
  }
}

export function compileAllScopes(source: string): Json {
  return SCOPES.map((scope) => compileOut(source, scope));
}

export function tokensOut(source: string): Json {
  try {
    return tokenize(source).map((t) => [
      t.type,
      t.text,
      t.column,
      t.value === null || typeof t.value === "string" ? t.value : t.value.toString(),
    ]);
  } catch (error) {
    return errorOut(error);
  }
}

export function catalogOut(): Json {
  return [...METRICS.values()].map((spec) => [
    spec.name,
    spec.type,
    spec.unit,
    SCOPES.filter((scope) => spec.scopes.has(scope)),
    spec.doc,
    spec.args === null
      ? null
      : spec.args.map((a) => [
          a.name,
          a.type,
          a.minimum,
          a.maximum,
          a.choices,
          a.reference,
          a.variadic,
        ]),
    spec.choices,
  ]);
}
