/** Did-you-mean hints for unknown keys, values and expression names (`rules/hints.py`). */

import { pyLower } from "../../text.js";

/**
 * `closest_match`: the candidate closest to `text`, or null when nothing is close enough to be a
 * plausible typo. Optimal string alignment distance (a swap of two neighbouring letters is one edit),
 * case-insensitive, over code points like Python. Allowed distance: 1 for up to 4 characters, 2 for up
 * to 8, else 3. The first candidate wins a tie.
 */
export function closestMatch(text: string, candidates: Iterable<string>): string | null {
  const needle = Array.from(pyLower(text));
  const maxDistance = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  let best: string | null = null;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    const distance = editDistance(needle, Array.from(pyLower(candidate)));
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** `did_you_mean`: ` (did you mean "x"?)` for the `closestMatch` of `text`, or an empty string. */
export function didYouMean(text: string, candidates: Iterable<string>): string {
  const match = closestMatch(text, candidates);
  return match === null ? "" : ` (did you mean "${match}"?)`;
}

function editDistance(a: readonly string[], b: readonly string[]): number {
  if (a.length === b.length && a.every((ch, i) => ch === b[i])) return 0;
  // Inputs are short (keys, names); bail out early on absurd lengths to keep this O(small).
  if (Math.abs(a.length - b.length) > 3 || a.length > 64 || b.length > 64) return 99;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push(new Array<number>(b.length + 1).fill(0));
  const at = (i: number, j: number): number => (rows[i] as number[])[j] as number;
  for (let i = 0; i <= a.length; i++) (rows[i] as number[])[0] = i;
  for (let j = 0; j <= b.length; j++) (rows[0] as number[])[j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, at(i - 2, j - 2) + 1);
      }
      (rows[i] as number[])[j] = best;
    }
  }
  return at(a.length, b.length);
}
