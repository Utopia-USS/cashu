// Guard: no raw color / spacing / type literals in app UI code. Style values come from the tokens
// of the UI system (one source: CSS variables / the Tailwind v4 theme); an app writes token
// references, never the values (cashu-ui skill, references/tokens.md).
import { stripComments } from "../repo.ts";

export interface StyleHit {
  line: number;
  kind: string;
  text: string;
}

const SPACING_PROPS =
  "(?:padding|margin)(?:Top|Right|Bottom|Left|Horizontal|Vertical|Start|End|Block|Inline)?|gap|rowGap|columnGap|inset|fontSize|lineHeight|letterSpacing|borderRadius|border(?:Top|Bottom)(?:Left|Right)Radius";
const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const TW_COLOR_UTIL =
  "bg|text|border|fill|stroke|ring|outline|from|via|to|divide|shadow|decoration|accent|caret|placeholder";

// Tailwind arbitrary values, as a utility (`p-[13px]`, `-top-[5px]`, `bg-[#0af]`, `text-[rgb(...)]`) or as
// a variant, also behind other variants (`hover:p-[13px]`, `max-[861px]:`, `@max-[1000px]:`,
// `dark:min-[40rem]:`). The value is raw when it starts with a literal, holds a length literal anywhere
// (`[calc(861px)]`, `[1fr_320px]`; `_` is Tailwind's space) or falls back to a literal
// (`[var(--x,.07em)]`). Token references stay allowed (`[--spacing(30)_minmax(0,1fr)]`,
// `[var(--color-accent)]`), and so do the fractions and percentages of a layout (`[2fr_1fr]`,
// `[minmax(0,5fr)]`, `[center_90%]`).
const TW_ARBITRARY = /(?:^|[\s"'`:])(!?-?@?[a-z][a-z0-9-]*-\[([^\]\s"'`]*)\])/g;
const RAW_ARBITRARY: readonly RegExp[] = [
  /^(?:#|rgb|hsl|oklch|-?\.?\d(?![\d.]*fr(?![a-z\d-])))/i,
  /(?<![a-z\d.-])-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|r?em|ch|ex|cap|lh|[sdl]?v(?:w|h|min|max|i|b)|pt|pc|cm|mm|in|q)(?![a-z\d-])/i,
  /\bcalc\(\s*-?\.?\d/,
  /\bvar\(\s*--[\w-]+\s*,\s*(?:#|-?\.?\d|rgb|hsl|oklch)/,
];

function rawArbitraryValue(line: string): string | null {
  for (const m of line.matchAll(TW_ARBITRARY)) {
    const value = m[2] ?? "";
    if (RAW_ARBITRARY.some((re) => re.test(value))) return m[1] ?? null;
  }
  return null;
}

/** A rule finds the first raw literal of a line, or null. */
const match =
  (re: RegExp) =>
  (line: string): string | null =>
    re.exec(line)?.[0].trim() ?? null;

const RULES: ReadonlyArray<{ kind: string; find: (line: string) => string | null }> = [
  {
    kind: "hex color",
    find: match(
      /["'`][^"'`\n]*#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b[^"'`\n]*["'`]/,
    ),
  },
  { kind: "color function", find: match(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*\d/) },
  // `padding: 12` / `fontSize: 14.5` (0 is not a design decision)
  {
    kind: "numeric spacing / type",
    find: match(
      new RegExp(`\\b(?:${SPACING_PROPS})\\s*:\\s*-?(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d+)\\b`),
    ),
  },
  // `padding: "12px"` / `margin: '1rem'`
  {
    kind: "unit spacing / type",
    find: match(
      new RegExp(`\\b(?:${SPACING_PROPS})\\s*:\\s*["'\`]-?\\d+(?:\\.\\d+)?(?:px|rem|em|pt)\\b`),
    ),
  },
  { kind: "tailwind arbitrary value", find: rawArbitraryValue },
  // Tailwind raw palette instead of a role: `bg-red-500`, `text-white`
  {
    kind: "tailwind raw palette",
    find: match(
      new RegExp(
        `(?:^|[\\s"'\`:])(?:${TW_COLOR_UTIL})-(?:(?:${PALETTE})-\\d{2,3}|black|white)(?:/\\d+)?(?=$|[\\s"'\`])`,
      ),
    ),
  },
];

/** Raw style literals in one source file (comments ignored). */
export function findRawStyles(source: string): StyleHit[] {
  const hits: StyleHit[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const { kind, find } of RULES) {
        const text = find(line);
        if (text) hits.push({ line: i + 1, kind, text });
      }
    });
  return hits;
}
