// Shape-only adapter from the reviewed domain parser to the existing literal privacy policy.
import { expr } from "@cashu/domain/investments/rules";
import type { ExprDeps, ExprNode } from "./exprTypes.js";

function privacyNode(node: expr.ExprNode): ExprNode {
  switch (node.type) {
    case "Number":
      return { kind: "number", value: node.value, text: node.text, column: node.column };
    case "String":
      return { kind: "string", value: node.value, column: node.column };
    case "Boolean":
      return { kind: "boolean", value: node.value, column: node.column };
    case "Name":
      return { kind: "name", name: node.name, column: node.column };
    case "Call":
      return {
        kind: "call",
        name: node.name,
        args: node.args.map(privacyNode),
        column: node.column,
      };
    case "Unary":
      return {
        kind: "unary",
        op: node.op,
        operand: privacyNode(node.operand),
        column: node.column,
      };
    case "Binary":
    case "Compare":
      return {
        kind: node.type === "Binary" ? "binary" : "compare",
        op: node.op,
        left: privacyNode(node.left),
        right: privacyNode(node.right),
        column: node.column,
      };
    case "Logical":
      return {
        kind: "logical",
        op: node.op,
        operands: node.operands.map(privacyNode),
        column: node.column,
      };
  }
}

export const nativeExprDeps: ExprDeps = {
  parse(source) {
    try {
      return privacyNode(expr.parse(source));
    } catch (error) {
      if (error instanceof expr.ExpressionError) return null;
      throw error;
    }
  },
  metricUnit: (name) => expr.METRICS.get(name)?.unit ?? null,
};
