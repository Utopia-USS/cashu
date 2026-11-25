/**
 * Hard limits of the custom-rule expression language (`rules/expr/limits.py`). They bound parse and
 * evaluation cost, so a hostile or runaway expression is rejected with a clear error instead of
 * exhausting memory or the stack.
 */

import { D, type Decimal } from "../../../decimal.js";

/** Characters (code points) in one `when` expression. */
export const MAX_EXPRESSION_LENGTH = 1000;

/** Tokens (numbers, names, operators, parentheses) in one expression. */
export const MAX_TOKENS = 200;

/** Nesting depth of the syntax tree (parentheses, unary operators, function calls, operator chains). */
export const MAX_DEPTH = 24;

export const MAX_NAME_LENGTH = 64;
export const MAX_NUMBER_LENGTH = 24;
export const MAX_STRING_LENGTH = 100;
export const MAX_FUNCTION_ARGS = 10;

/** Largest price window (bars) a metric function accepts; about ten years of sessions. */
export const MAX_WINDOW_DAYS = 2520;

/**
 * Numbers closer than this compare as equal, so a value exactly on a threshold does not fire because of
 * floating-point noise in derived ratios (the built-in rules use the same tolerance).
 */
export const COMPARISON_TOLERANCE: Decimal = D("1e-9");
