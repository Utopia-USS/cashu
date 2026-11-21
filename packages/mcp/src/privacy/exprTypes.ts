// The stable tree consumed by the literal privacy policy; native parser adaptation is separate.
import type { Decimal } from "@cashu/domain";

/** How a numeric metric is shown in messages (`rules/expr/catalog.py` `Unit`). */
export type ExprUnit = "ratio" | "pp" | "amount" | "price" | "days" | "count" | "text" | "flag";

/** The parser's syntax tree (`rules/expr/parser.py`); `column` is 1-based (code points). */
export type ExprNode =
  | {
      readonly kind: "number";
      readonly value: Decimal;
      readonly text: string;
      readonly column: number;
    }
  | { readonly kind: "string"; readonly value: string; readonly column: number }
  | { readonly kind: "boolean"; readonly value: boolean; readonly column: number }
  | { readonly kind: "name"; readonly name: string; readonly column: number }
  | {
      readonly kind: "call";
      readonly name: string;
      readonly args: readonly ExprNode[];
      readonly column: number;
    }
  | {
      readonly kind: "unary";
      readonly op: string;
      readonly operand: ExprNode;
      readonly column: number;
    }
  | {
      readonly kind: "binary" | "compare";
      readonly op: string;
      readonly left: ExprNode;
      readonly right: ExprNode;
      readonly column: number;
    }
  | {
      readonly kind: "logical";
      readonly op: string;
      readonly operands: readonly ExprNode[];
      readonly column: number;
    };

export interface ExprDeps {
  /** The parsed tree, or null when the expression does not parse (`ExpressionError`). */
  readonly parse: (source: string) => ExprNode | null;
  /** The unit of a metric or metric function, or null for an unknown name. */
  readonly metricUnit: (name: string) => ExprUnit | null;
}
