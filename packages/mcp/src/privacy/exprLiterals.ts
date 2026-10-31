/**
 * Which number literals of a custom-rule expression are personal amounts (strict MCP privacy, F6
 * review V3). Port of `modules/investments/rules/expr/privacy.py`; pure.
 *
 * A custom condition such as `cash_value < 800` carries the owner's buffer in its literal. A literal
 * is kept only when it is clearly not money:
 *
 * - a percent literal (`20%`);
 * - a literal argument of a metric function (a window length, `drawdown_from_high(252)`);
 * - a literal inside a comparison whose metrics are all ratios, percentage points, days or counts
 *   (`weight < 0.03`), or prices of a public instrument (`last_close > 120`), unless a literal is
 *   scaled into an amount (added to / multiplied with a price, or a factor other than 1 / 100 on any
 *   metric), or literals are multiplied / divided by each other (`weight > 900 / 120000`).
 *
 * Everything else is treated as an amount. An expression that does not parse loses every bare number.
 *
 * TRANSITIONAL(S15a): the expression parser and the metric catalog are not ported yet, so the syntax
 * tree shape (`ExprNode`, the Python parser's dataclasses) and the two lookups come in as `ExprDeps`.
 * When S15a lands its `parse` and `METRICS`, this file moves next to them in
 * `@cashu/domain/investments` and the deps become imports.
 */

import { type Decimal, D as dec } from "@cashu/domain";
import { D, pyRe, W } from "./pyRegex.js";

export const AMOUNT_PLACEHOLDER = "[amount]";

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

type NumberNode = Extract<ExprNode, { kind: "number" }>;

export interface ExprDeps {
  /** The parsed tree, or null when the expression does not parse (`ExpressionError`). */
  readonly parse: (source: string) => ExprNode | null;
  /** The unit of a metric or metric function, or null for an unknown name. */
  readonly metricUnit: (name: string) => ExprUnit | null;
}

const NON_MONEY: ReadonlySet<ExprUnit | null> = new Set([
  "ratio",
  "pp",
  "days",
  "count",
  "flag",
  "text",
]);
const BARE_NUMBER = pyRe(`(?<![${W}.])${D}+(?:\\.${D}+)?|(?<![${W}.])\\.${D}+`, "g");
const ONE = dec("1");
const HUNDRED = dec("100");

/** Direct sub-expressions of `node`. */
function children(node: ExprNode): readonly ExprNode[] {
  switch (node.kind) {
    case "call":
      return node.args;
    case "unary":
      return [node.operand];
    case "binary":
    case "compare":
      return [node.left, node.right];
    case "logical":
      return node.operands;
    default:
      return [];
  }
}

function units(node: ExprNode, deps: ExprDeps): (ExprUnit | null)[] {
  const out: (ExprUnit | null)[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop() as ExprNode;
    if (current.kind === "name" || current.kind === "call") {
      out.push(deps.metricUnit(current.name));
      continue; // literal arguments of a call are never compared
    }
    stack.push(...children(current));
  }
  return out;
}

/** Number literals under `node` that are not metric-function arguments. */
function numbers(node: ExprNode): NumberNode[] {
  const out: NumberNode[] = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop() as ExprNode;
    if (current.kind === "number") out.push(current);
    else if (current.kind !== "call") stack.push(...children(current));
  }
  return out;
}

/** A literal factor that keeps a non-price metric in its unit (`weight * 100 > 5`). */
function scaleOk(n: NumberNode): boolean {
  return n.value.compare(ONE) === 0 || n.value.compare(HUNDRED) === 0;
}

function scalesIntoAmount(n: NumberNode): boolean {
  return !scaleOk(n) && !n.text.endsWith("%");
}

/**
 * True when a literal takes part in arithmetic that can turn the comparison into an amount: any
 * literal added to / multiplied with / divided by a price, a literal other than 1 / 100 multiplying
 * or dividing any metric, or literals multiplied / divided by each other with no metric between
 * them (unless every one is 1, 100 or a percent). Conservative: false positives only scrub a safe
 * literal.
 */
function scaled(node: ExprNode, deps: ExprDeps): boolean {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop() as ExprNode;
    if (current.kind === "call") continue;
    if (current.kind === "binary") {
      if (
        (current.op === "*" || current.op === "/") &&
        units(current.left, deps).length === 0 &&
        units(current.right, deps).length === 0 &&
        numbers(current).some(scalesIntoAmount)
      ) {
        return true;
      }
      for (const [side, other] of [
        [current.left, current.right],
        [current.right, current.left],
      ] as const) {
        const literals = numbers(side);
        const otherUnits = units(other, deps);
        if (literals.length === 0 || otherUnits.length === 0) continue;
        if (otherUnits.includes("price")) return true;
        if ((current.op === "*" || current.op === "/") && literals.some(scalesIntoAmount))
          return true;
      }
    }
    stack.push(...children(current));
  }
  return false;
}

function safe(found: readonly (ExprUnit | null)[], privatePrices: boolean): boolean {
  if (found.length === 0) return false;
  return found.every((unit) => NON_MONEY.has(unit) || (unit === "price" && !privatePrices));
}

export interface LiteralOptions {
  /** The compared instrument is owner-named: its prices are amounts too. */
  readonly privatePrices?: boolean;
}

/** The number literals of `source` that count as amounts (null when it does not parse). */
export function amountLiterals(
  source: string,
  deps: ExprDeps,
  { privatePrices = false }: LiteralOptions = {},
): NumberNode[] | null {
  const tree = deps.parse(source);
  if (tree === null) return null;
  const flagged: NumberNode[] = [];
  const stack: ExprNode[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop() as ExprNode;
    if (node.kind === "compare") {
      const ok = safe(units(node, deps), privatePrices) && !scaled(node, deps);
      for (const n of numbers(node)) if (!ok && !n.text.endsWith("%")) flagged.push(n);
      continue;
    }
    if (node.kind === "number") {
      if (!node.text.endsWith("%")) flagged.push(node); // a bare literal outside any comparison
      continue;
    }
    if (node.kind === "call") continue;
    stack.push(...children(node));
  }
  return flagged;
}

/** `source` with every amount literal replaced by `placeholder` (see the module doc). */
export function scrubAmountLiterals(
  source: string,
  deps: ExprDeps,
  {
    privatePrices = false,
    placeholder = AMOUNT_PLACEHOLDER,
  }: LiteralOptions & { readonly placeholder?: string } = {},
): string {
  const flagged = amountLiterals(source, deps, { privatePrices });
  if (flagged === null) {
    return source.replace(BARE_NUMBER, (m: string, offset: number) =>
      source.slice(offset + m.length, offset + m.length + 1) === "%" ? m : placeholder,
    );
  }
  const out = Array.from(source);
  for (const n of [...flagged].sort((a, b) => b.column - a.column)) {
    const start = n.column - 1;
    const text = Array.from(n.text);
    if (out.slice(start, start + text.length).join("") === n.text) {
      out.splice(start, text.length, ...Array.from(placeholder));
    }
  }
  return out.join("");
}
