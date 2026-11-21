/**
 * Python `difflib` close matches (`SequenceMatcher(None, a, b)` with `autojunk=True`,
 * `get_close_matches`), over code points. The canonical budget import suggests a column name with it;
 * checked against Python by `difflib.test.ts` (`budget-difflib.jsonl`).
 */

interface Match {
  readonly i: number;
  readonly j: number;
  readonly size: number;
}

/** `SequenceMatcher` with `b` fixed (its index of `b`'s elements, popular ones removed). */
class Matcher {
  private readonly b: readonly string[];
  private readonly b2j = new Map<string, number[]>();
  private readonly fullBCount = new Map<string, number>();

  constructor(b: string) {
    this.b = Array.from(b);
    this.b.forEach((elt, i) => {
      const list = this.b2j.get(elt);
      if (list) list.push(i);
      else this.b2j.set(elt, [i]);
      this.fullBCount.set(elt, (this.fullBCount.get(elt) ?? 0) + 1);
    });
    // autojunk: in a b of 200+ elements, an element in more than 1% (+1) of the positions is dropped.
    const n = this.b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [elt, idxs] of [...this.b2j]) if (idxs.length > ntest) this.b2j.delete(elt);
    }
  }

  /** `find_longest_match` (no junk function: only the extension over equal elements). */
  private longest(a: readonly string[], alo: number, ahi: number, blo: number, bhi: number): Match {
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const next = new Map<number, number>();
      for (const j of this.b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = next;
    }
    while (besti > alo && bestj > blo && a[besti - 1] === this.b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === this.b[bestj + bestsize]
    ) {
      bestsize++;
    }
    return { i: besti, j: bestj, size: bestsize };
  }

  /** Sum of `get_matching_blocks()` sizes. */
  private matches(a: readonly string[]): number {
    let total = 0;
    const queue: [number, number, number, number][] = [[0, a.length, 0, this.b.length]];
    for (let item = queue.pop(); item !== undefined; item = queue.pop()) {
      const [alo, ahi, blo, bhi] = item;
      const { i, j, size } = this.longest(a, alo, ahi, blo, bhi);
      if (size === 0) continue;
      total += size;
      if (alo < i && blo < j) queue.push([alo, i, blo, j]);
      if (i + size < ahi && j + size < bhi) queue.push([i + size, ahi, j + size, bhi]);
    }
    return total;
  }

  ratio(aText: string): number {
    const a = Array.from(aText);
    const length = a.length + this.b.length;
    return length ? (2.0 * this.matches(a)) / length : 1.0;
  }

  /** `quick_ratio`: an upper bound from the element multisets. */
  quickRatio(aText: string): number {
    const a = Array.from(aText);
    const avail = new Map<string, number>();
    let matches = 0;
    for (const elt of a) {
      const have = avail.has(elt) ? (avail.get(elt) as number) : (this.fullBCount.get(elt) ?? 0);
      avail.set(elt, have - 1);
      if (have > 0) matches++;
    }
    const length = a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }

  /** `real_quick_ratio`: an upper bound from the lengths. */
  realQuickRatio(aText: string): number {
    const la = Array.from(aText).length;
    const lb = this.b.length;
    const length = la + lb;
    return length ? (2.0 * Math.min(la, lb)) / length : 1.0;
  }
}

/** `SequenceMatcher(None, a, b).ratio()`. */
export function sequenceRatio(a: string, b: string): number {
  return new Matcher(b).ratio(a);
}

/**
 * `difflib.get_close_matches(word, possibilities, n, cutoff)`: the best `n` possibilities scoring at
 * least `cutoff`, best first (ties: the greater string first, as `heapq.nlargest` on tuples).
 */
export function getCloseMatches(
  word: string,
  possibilities: readonly string[],
  n = 3,
  cutoff = 0.6,
): string[] {
  if (n <= 0) throw new RangeError(`n must be > 0: ${n}`);
  if (!(cutoff >= 0 && cutoff <= 1))
    throw new RangeError(`cutoff must be in [0.0, 1.0]: ${cutoff}`);
  const matcher = new Matcher(word);
  const scored: [number, string][] = [];
  for (const x of possibilities) {
    if (matcher.realQuickRatio(x) >= cutoff && matcher.quickRatio(x) >= cutoff) {
      const score = matcher.ratio(x);
      if (score >= cutoff) scored.push([score, x]);
    }
  }
  scored.sort(([sa, xa], [sb, xb]) => (sb !== sa ? sb - sa : xb < xa ? -1 : xb > xa ? 1 : 0));
  return scored.slice(0, n).map(([, x]) => x);
}
