/**
 * Syntax tree of the custom-rule expression language (`rules/expr/parser.py` dataclasses). Node
 * objects keep the Python field names plus a `type` discriminant (the Python class name), so a
 * serializer can emit them 1:1.
 */

import type { Decimal } from "../../../decimal.js";

export interface NumberNode {
  readonly type: "Number";
  readonly value: Decimal;
  readonly text: string;
  readonly column: number;
}

export interface StringNode {
  readonly type: "String";
  readonly value: string;
  readonly column: number;
}

export interface BooleanNode {
  readonly type: "Boolean";
  readonly value: boolean;
  readonly column: number;
}

export interface NameNode {
  readonly type: "Name";
  readonly name: string;
  readonly column: number;
}

export interface CallNode {
  readonly type: "Call";
  readonly name: string;
  readonly args: readonly ExprNode[];
  readonly column: number;
}

export interface UnaryNode {
  readonly type: "Unary";
  /** `-`, `+` or `not`. */
  readonly op: string;
  readonly operand: ExprNode;
  readonly column: number;
}

export interface BinaryNode {
  readonly type: "Binary";
  /** `+`, `-`, `*` or `/`. */
  readonly op: string;
  readonly left: ExprNode;
  readonly right: ExprNode;
  /** Column of the operator. */
  readonly column: number;
}

export interface CompareNode {
  readonly type: "Compare";
  /** `<`, `<=`, `>`, `>=`, `==` or `!=`. */
  readonly op: string;
  readonly left: ExprNode;
  readonly right: ExprNode;
  /** Column of the operator. */
  readonly column: number;
}

export interface LogicalNode {
  readonly type: "Logical";
  /** `and` or `or`; n-ary so long chains stay shallow. */
  readonly op: string;
  readonly operands: readonly ExprNode[];
  /** Column of the first operator. */
  readonly column: number;
}

/** Python `Node`. */
export type ExprNode =
  | NumberNode
  | StringNode
  | BooleanNode
  | NameNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | CompareNode
  | LogicalNode;

/** Direct sub-expressions of `node`. */
export function children(node: ExprNode): readonly ExprNode[] {
  switch (node.type) {
    case "Call":
      return node.args;
    case "Unary":
      return [node.operand];
    case "Binary":
    case "Compare":
      return [node.left, node.right];
    case "Logical":
      return node.operands;
    default:
      return [];
  }
}
