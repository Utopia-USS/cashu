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
 */

import { pySplit } from "@cashu/domain";
import { type ExprDeps, scrubAmountLiterals } from "./exprLiterals.js";
import { type Labelled, text as textLabel } from "./labels.js";
import { B, D, pyRe, S, W } from "./pyRegex.js";

const NUMBER_OR_KEPT = pyRe(
  `(?<keep>` +
    `${B}${D}{4}-${D}{2}-${D}{2}${B}` + // ISO dates
    `|\\[${D}+\\]` + // list indexes: rules[3]
    `|${B}(?:rows?|lines?|columns?)[${S}]+${D}+${B}` + // positions in a file
    `|(?<![${W}.,])[\\-+]?${D}+(?:[.,]${D}+)?[${S}]?(?:%|pp${B})` + // percentages / percentage points
    `)` +
    `|(?<number>(?<![${W}.,])[\\-+]?${D}+(?:[ \\u00a0,.]${D}{3})*(?:[.,]${D}+)?(?![${W}%]))`,
  "g",
);

/** The privacy level of the call a message is built for. */
export interface PrivacyContext {
  readonly strict: boolean;
}

/** `text` with every number replaced by `#` except dates, percentages, indexes and file positions. */
export function scrubNumbers(text: string): string {
  return text.replace(NUMBER_OR_KEPT, (...args: unknown[]) => {
    const groups = args[args.length - 1] as { keep?: string };
    return groups.keep ?? "#";
  });
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
  deps: ExprDeps,
  { privatePrices = false }: { readonly privatePrices?: boolean } = {},
): Labelled {
  if (value === null || !ctx.strict) return textLabel(value);
  return textLabel(scrubAmountLiterals(value, deps, { privatePrices }));
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
  deps: ExprDeps,
  { privatePrices = false }: { readonly privatePrices?: boolean } = {},
): Labelled {
  if (message === null || !ctx.strict) return textLabel(message);
  if (when) {
    const normalized = pySplit(when).join(" ");
    const scrubbed = scrubAmountLiterals(normalized, deps, { privatePrices });
    return textLabel(splitOn(message, normalized).map(scrubNumbers).join(scrubbed));
  }
  return textLabel(scrubNumbers(message));
}
