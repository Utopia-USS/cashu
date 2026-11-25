/** The spelling hint of importer messages (`csv_mapping.did_you_mean`). */

import { getCloseMatches } from "../../difflib.js";
import { pyLower } from "../../text.js";

/**
 * ` (did you mean "x"?)` for the candidate closest to `text` (case-insensitive, similarity at least
 * 0.6), or an empty string.
 */
export function didYouMean(text: string, candidates: Iterable<string>): string {
  const byLower = new Map<string, string>();
  for (const candidate of candidates) byLower.set(pyLower(candidate), candidate);
  const [match] = getCloseMatches(pyLower(text), [...byLower.keys()], 1, 0.6);
  return match === undefined ? "" : ` (did you mean "${byLower.get(match)}"?)`;
}
