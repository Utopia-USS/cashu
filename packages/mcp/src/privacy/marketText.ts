/**
 * The macro card summary gate (`investments/macro/texts.summary_ok`): a `market` text that is not a
 * metric label or a formatted number passes only when it uses nothing but the summary builder's
 * vocabulary, numbers and its punctuation. The vocabulary (every word `summary()` can write in
 * Polish) belongs to the investments macro module, which supplies it.
 */

import type { SummaryCheck } from "./labels.js";
import { D, END, pyRe, S, W } from "./pyRegex.js";
import { pyLen } from "./pyText.js";

/** Maximum length of a summary (`macro.texts.SUMMARY_MAX`). */
export const SUMMARY_MAX = 140;

const WORD = pyRe("[\\p{L}\\p{Nl}\\p{No}]+", "g"); // Python [^\W\d_]
const ALLOWED = pyRe(`^[${W}${S}%+\\-,.:/]*${END}`);
const LONG_NUMBER = pyRe(`${D}{5,}`);

/** `summary_ok` over the given vocabulary. */
export function macroSummaryChecker(
  vocabulary: ReadonlySet<string>,
  summaryMax = SUMMARY_MAX,
): SummaryCheck {
  return (text: string) => {
    if (typeof text !== "string" || pyLen(text) > 2 * summaryMax || !ALLOWED.test(text))
      return false;
    if (!text.endsWith(".") || LONG_NUMBER.test(text)) return false;
    const words = text.match(WORD) ?? [];
    return words.length >= 3 && words.every((w) => vocabulary.has(w));
  };
}
