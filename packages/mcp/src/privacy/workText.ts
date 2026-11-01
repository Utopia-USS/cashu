/**
 * The normalized copy of a text the scrub rules match on (port of `_norm_char` / `_Work` in
 * `core/mcp/redaction.py`, S37fix D1): NFKC per code point, every Unicode space, tab, line break and
 * zero-width character becomes one ASCII space, soft hyphens are removed and every dash becomes "-".
 * Each normalized UTF-16 unit remembers the original code point it came from, so `render` gives back
 * the original text everywhere except the replaced spans.
 */

/** Zero-width space, non-joiner, joiner, word joiner and BOM (written as code points: invisible). */
const ZERO_WIDTH: ReadonlySet<string> = new Set(
  [0x200b, 0x200c, 0x200d, 0x2060, 0xfeff].map((cp) => String.fromCodePoint(cp)),
);
/** Tab, line and paragraph breaks, the C0 separators and NEL (Python's other whitespace). */
const LINE_SPACE: ReadonlySet<string> = new Set(
  [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0x2028, 0x2029].map((cp) =>
    String.fromCodePoint(cp),
  ),
);
const REMOVED = String.fromCodePoint(0xad); // soft hyphen
const ZS = /^\p{Zs}$/u;
const PD = /^\p{Pd}$/u;

/** S37fix3: `normChar` is a pure function of one code point, called per code point. */
const NORM_CACHE = new Map<string, string>();

/** One code point normalized for matching ("" when it is removed). */
function normChar(ch: string): string {
  const cached = NORM_CACHE.get(ch);
  if (cached !== undefined) return cached;
  const out = normCharUncached(ch);
  if (NORM_CACHE.size >= 4096) NORM_CACHE.clear();
  NORM_CACHE.set(ch, out);
  return out;
}

function normCharUncached(ch: string): string {
  if (ch === REMOVED) return "";
  let out = "";
  for (const c of ch.normalize("NFKC")) {
    if (c === REMOVED) continue;
    if (ZERO_WIDTH.has(c) || LINE_SPACE.has(c) || ZS.test(c)) out += " ";
    else if (PD.test(c) || c === "−") out += "-";
    else out += c;
  }
  return out;
}

/** The normalized copy the identifier and amount rules match on. */
export function normalizeForMatching(text: string): string {
  let out = "";
  for (const ch of text) out += normChar(ch);
  return out;
}

/** Saved characters put back by a replacement: the text and the original index of each unit. */
export type Restored = readonly [string, readonly (number | null)[]];
type WorkReplacement = string | null | Restored;
export type WorkReplacer = (m: RegExpMatchArray) => WorkReplacement;

/** `target.push(...items)` without spreading (a spread of 100k+ items overflows the stack). */
function pushAll<T>(target: T[], items: readonly T[], from = 0, to = items.length): void {
  for (let k = from; k < to; k++) target.push(items[k] as T);
}

export class WorkText {
  private readonly orig: readonly string[];
  private readonly removed: readonly boolean[];
  text: string;
  /** Per UTF-16 unit of `text`: the original code point index, or null for a replacement. */
  src: (number | null)[];
  private readonly touched = new Set<number>();
  private changed = false;

  constructor(value: string) {
    this.orig = Array.from(value);
    const removed: boolean[] = [];
    const src: (number | null)[] = [];
    let text = "";
    this.orig.forEach((ch, i) => {
      const n = normChar(ch);
      removed.push(n === "");
      text += n;
      for (let k = 0; k < n.length; k++) src.push(i);
    });
    this.removed = removed;
    this.text = text;
    this.src = src;
  }

  /**
   * `pattern.sub` on the normalized text (`pattern` has the `g` flag). `repl` is a string or returns
   * the replacement, `null` (keep the match) or `[text, sources]` (restore saved characters).
   */
  sub(pattern: RegExp, repl: string | WorkReplacer, mark = true): void {
    let out = "";
    const src: (number | null)[] = [];
    let last = 0;
    let replaced = false;
    for (const m of this.text.matchAll(pattern)) {
      const r = typeof repl === "string" ? repl : repl(m);
      if (r === null) continue;
      const start = m.index as number;
      const end = start + m[0].length;
      out += this.text.slice(last, start);
      pushAll(src, this.src, last, start);
      if (mark) {
        for (let k = start; k < end; k++) {
          const s = this.src[k] as number | null;
          if (s !== null) this.touched.add(s);
        }
      }
      if (typeof r === "string") {
        out += r;
        for (let k = 0; k < r.length; k++) src.push(null);
      } else {
        out += r[0];
        pushAll(src, r[1]);
      }
      last = end;
      replaced = true;
    }
    if (!replaced) return;
    this.changed = true;
    out += this.text.slice(last);
    pushAll(src, this.src, last);
    this.text = out;
    this.src = src;
  }

  /** The original text with the replacements in place. */
  render(): string {
    if (!this.changed) return this.orig.join(""); // nothing replaced: the original text as it is
    let out = "";
    let prev: number | null = null;
    for (let k = 0; k < this.text.length; k++) {
      const s = this.src[k] as number | null;
      if (s === null || this.touched.has(s)) {
        out += this.text[k];
        continue;
      }
      if (s === prev) continue;
      prev = s;
      let j = s - 1;
      const pre: string[] = [];
      while (j >= 0 && this.removed[j]) {
        pre.push(this.orig[j] as string);
        j -= 1;
      }
      out += pre.reverse().join("") + (this.orig[s] as string);
    }
    let tail = this.orig.length;
    while (tail > 0 && this.removed[tail - 1]) tail -= 1;
    return out + this.orig.slice(tail).join(""); // removed characters at the very end
  }
}
