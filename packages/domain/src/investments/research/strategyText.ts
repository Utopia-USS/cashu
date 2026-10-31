/**
 * The parts of the owner's `strategy.md` a research run needs (`research/strategy_text.py`): what
 * the owner believes, the entry and exit rules, and what the owner avoids. Pure: markdown in,
 * sections out (the MCP layer labels the text).
 *
 * A section is a markdown heading (any level) and the lines up to the next heading of the same or a
 * higher level. Headings are matched case- and accent-insensitively by keywords (Polish and English,
 * matching data verbatim from Python).
 */

import { pyCasefold } from "../../casefold.js";
import { pyRegex } from "../../pyRegex.js";
import { isCombining, isPySpace, pyStrip } from "../../text.js";

/** Characters kept per section (longer text is cut at a line end with `...`). */
export const SECTION_MAX = 1500;

/** `_KEYWORDS`, verbatim. */
export const SECTION_KEYWORDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  beliefs: Object.freeze([
    "przekonan",
    "wierze",
    "filozof",
    "podejscie",
    "teza inwestycyjna",
    "belief",
    "philosophy",
    "approach",
  ]),
  entry_exit: Object.freeze(["wejsci", "wyjsci", "entry", "exit", "kupuj", "sprzedaj"]),
  avoid: Object.freeze(["unikam", "unikac", "wyklucz", "czego nie", "avoid", "exclude"]),
});
export const SECTION_KINDS: readonly string[] = Object.freeze(Object.keys(SECTION_KEYWORDS));

/** `_HEADING` / `_FENCE` Python sources, verbatim. */
export const HEADING_PATTERN = String.raw`^(#{1,6})\s+(.+?)\s*#*\s*$`;
export const FENCE_PATTERN = "^\\s*(```|~~~)";

const HEADING = pyRegex(HEADING_PATTERN);
const FENCE = pyRegex(FENCE_PATTERN);

export interface StrategySection {
  /** beliefs | entry_exit | avoid */
  readonly kind: string;
  readonly heading: string;
  readonly text: string;
}

/** `_fold`: `ł` -> `l`, accents stripped (NFKD), casefolded. */
export function foldHeading(text: string): string {
  const decomposed = text.replaceAll("ł", "l").replaceAll("Ł", "L").normalize("NFKD");
  let kept = "";
  for (const ch of decomposed) if (!isCombining(ch.codePointAt(0) as number)) kept += ch;
  return pyCasefold(kept);
}

/** `_kind`: the section kind a heading names by keyword, else null. */
export function sectionKind(heading: string): string | null {
  const folded = foldHeading(heading);
  for (const [kind, words] of Object.entries(SECTION_KEYWORDS)) {
    if (words.some((w) => folded.includes(w))) return kind;
  }
  return null;
}

function rstrip(points: readonly string[]): string {
  let end = points.length;
  while (end > 0 && isPySpace((points[end - 1] as string).codePointAt(0) as number)) end--;
  return points.slice(0, end).join("");
}

function bounded(text: string): string {
  const points = Array.from(pyStrip(text));
  if (points.length <= SECTION_MAX) return points.join("");
  const cut = points.slice(0, SECTION_MAX);
  const end = cut.lastIndexOf("\n");
  return `${rstrip(end > Math.floor(SECTION_MAX / 2) ? cut.slice(0, end) : cut)}\n...`;
}

/**
 * The beliefs / entry-exit / avoid sections of `markdown`, in file order (a kind may occur more
 * than once; empty sections are skipped).
 */
export function strategySections(markdown: string | null | undefined): StrategySection[] {
  if (!markdown) return [];
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const headings: [number, number, string][] = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    const m = fenced ? null : HEADING.exec(line);
    if (m) headings.push([i, (m[1] as string).length, pyStrip(m[2] as string)]);
  });
  const out: StrategySection[] = [];
  let coveredUntil = -1;
  headings.forEach(([index, level, title], n) => {
    const kind = sectionKind(title);
    if (kind === null || index < coveredUntil) return;
    let end = lines.length;
    for (const [laterIndex, laterLevel] of headings.slice(n + 1)) {
      if (laterLevel <= level) {
        end = laterIndex;
        break;
      }
    }
    coveredUntil = end;
    const text = bounded(lines.slice(index + 1, end).join("\n"));
    if (text) out.push({ kind, heading: Array.from(title).slice(0, 120).join(""), text });
  });
  return out;
}
