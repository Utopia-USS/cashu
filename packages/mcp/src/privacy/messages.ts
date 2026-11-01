/**
 * System messages in tool answers under the privacy level (port of `core/mcp/tools/messages.py`,
 * F5 R6).
 *
 * Portfolio warnings and strategy / rule validation issues are English sentences built from data: a
 * history gap names the missing quantity, a cash gap the negative balance, a strategy issue may quote
 * a value from the owner's file. The redactor's text scrub is pattern based, so a bare quantity or a
 * whole-number balance could pass it. In strict mode such a message therefore loses every number
 * except dates, percentages and percentage points, list indexes (`rules[3]`) and positions in a file
 * (`line 12`). Amounts mode sends the message as it is (the redactor still runs).
 *
 * S37fix3 E2: in strict mode a message never quotes a number: a quoted part with a digit becomes
 * `"#"` (`Invalid number "800k..."` -> `Invalid number "#"`, the column stays), a number glued to
 * letters (`800k`, `_800000`) is a number when it has 2+ digits (the N9 rule: `IS3N` stays), and only
 * a percentage with at most 3 integer digits is kept (the R1 / N1 rule). E4: the quoted text of a
 * custom condition (a tag, a symbol) goes through the free-text scrub (identifiers and strict
 * amounts).
 */

import { PY_B, PY_D, PY_W, PY_WS, pySplit, uRegex } from "@cashu/domain";
import { type ExprDeps, scrubAmountLiterals } from "./exprLiterals.js";
import { nativeExprDeps } from "./exprNative.js";
import { type Labelled, text as textLabel } from "./labels.js";
import { scrubText } from "./scrub.js";

const NUMBER_OR_KEPT = uRegex(
  `(?<keep>` +
    `${PY_B}${PY_D}{4}-${PY_D}{2}-${PY_D}{2}${PY_B}` + // ISO dates
    `|\\[${PY_D}+\\]` + // list indexes: rules[3]
    `|${PY_B}(?:rows?|lines?|columns?)[${PY_WS}]+${PY_D}+${PY_B}` + // positions in a file
    `|(?<![${PY_W}.,])[\\-+]?${PY_D}{1,3}(?:[.,]${PY_D}+)?[${PY_WS}]?(?:%|pp${PY_B})` + // percentages / percentage points
    `)` +
    `|(?<number>(?:(?<![${PY_W}.,])[\\-+])?(?<!${PY_D})(?<!${PY_D}[.,])${PY_D}+(?:[ \\u00a0,.]${PY_D}{3})*(?:[.,]${PY_D}+)?(?:[eE][\\-+]?${PY_D}+)?(?!${PY_D}))`,
  "g",
);
const QUOTED = /"[^"]*"/g;
const DIGIT = uRegex(PY_D);
const DIGITS = uRegex(PY_D, "g");
const LETTER_CHAR = /^\p{L}$/u;
/** A text literal of a custom condition (the lexer has no escapes: a quote ends it). */
const CONDITION_TEXT = /"[^"]*"|'[^']*'/g;

/** The privacy level of the call a message is built for. */
export interface PrivacyContext {
  readonly strict: boolean;
}

/** A letter or "_" at the code point that ends before / starts at `index`. */
function gluedBefore(text: string, index: number): boolean {
  const ch = Array.from(text.slice(Math.max(0, index - 2), index)).pop() ?? "";
  return ch === "_" || LETTER_CHAR.test(ch);
}

function gluedAfter(text: string, index: number): boolean {
  const cp = text.codePointAt(index);
  if (cp === undefined) return false;
  const ch = String.fromCodePoint(cp);
  return ch === "_" || LETTER_CHAR.test(ch);
}

/**
 * `text` with every number replaced by `#` except dates, percentages, indexes and file positions;
 * a quoted part with a digit becomes `"#"`.
 */
export function scrubNumbers(text: string): string {
  const unquoted = text.replace(QUOTED, (m: string) => (DIGIT.test(m) ? '"#"' : m));
  return unquoted.replace(NUMBER_OR_KEPT, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { keep?: string };
    if (groups.keep !== undefined) return groups.keep;
    const match = args[0] as string;
    const offset = args[args.length - 3] as number;
    const glued = gluedBefore(unquoted, offset) || gluedAfter(unquoted, offset + match.length);
    // one digit in a word ("IS3N", "rules_3") is not a quantity
    if (glued && Array.from(match.matchAll(DIGITS)).length < 2) return match;
    return "#";
  });
}

/**
 * A custom condition in strict mode: amount literals (see `customCondition`), then the free-text
 * scrub inside each text literal (S37fix3 E4).
 */
function scrubCondition(value: string, deps: ExprDeps, privatePrices: boolean): string {
  const scrubbed = scrubAmountLiterals(value, deps, { privatePrices });
  return scrubbed.replace(
    CONDITION_TEXT,
    (m: string) => m[0] + scrubText(m.slice(1, -1), { strict: true }) + m[m.length - 1],
  );
}

/** A system-built message as a text label: numbers scrubbed in strict mode. */
export function systemText(ctx: PrivacyContext, value: string | null): Labelled {
  if (value === null || !ctx.strict) return textLabel(value);
  return textLabel(scrubNumbers(value));
}

/**
 * A custom condition (alert `expression`, custom signal `when`) as text: in strict mode its number
 * literals compared with amounts (or with an owner-named instrument's price) become `[amount]`.
 */
export function customCondition(
  ctx: PrivacyContext,
  value: string | null,
  deps: ExprDeps = nativeExprDeps,
  { privatePrices = false }: { readonly privatePrices?: boolean } = {},
): Labelled {
  if (value === null || !ctx.strict) return textLabel(value);
  return textLabel(scrubCondition(value, deps, privatePrices));
}

/** Python `str.split(sep)` for a non-empty separator. */
function splitOn(text: string, sep: string): string[] {
  if (sep === "") throw new RangeError("empty separator");
  return text.split(sep);
}

/**
 * The message of a custom signal (the rule engine's Polish text; the condition is the normalized
 * `when` verbatim, so the message splits on it): in strict mode the condition inside it is scrubbed
 * like `customCondition` and every other number outside dates and percentages is removed.
 */
export function customSignalMessage(
  ctx: PrivacyContext,
  message: string | null,
  when: string | null,
  deps: ExprDeps = nativeExprDeps,
  { privatePrices = false }: { readonly privatePrices?: boolean } = {},
): Labelled {
  if (message === null || !ctx.strict) return textLabel(message);
  if (when) {
    const normalized = pySplit(when).join(" ");
    const scrubbed = scrubCondition(normalized, deps, privatePrices);
    return textLabel(splitOn(message, normalized).map(scrubNumbers).join(scrubbed));
  }
  return textLabel(scrubNumbers(message));
}
