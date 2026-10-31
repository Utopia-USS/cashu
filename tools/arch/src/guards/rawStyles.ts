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

const RULES: ReadonlyArray<{ kind: string; re: RegExp }> = [
  {
    kind: "hex color",
    re: /["'`][^"'`\n]*#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b[^"'`\n]*["'`]/,
  },
  { kind: "color function", re: /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb)\(\s*\d/ },
  // `padding: 12` / `fontSize: 14.5` (0 is not a design decision)
  {
    kind: "numeric spacing / type",
    re: new RegExp(`\\b(?:${SPACING_PROPS})\\s*:\\s*-?(?:[1-9]\\d*(?:\\.\\d+)?|0\\.\\d+)\\b`),
  },
  // `padding: "12px"` / `margin: '1rem'`
  {
    kind: "unit spacing / type",
    re: new RegExp(`\\b(?:${SPACING_PROPS})\\s*:\\s*["'\`]-?\\d+(?:\\.\\d+)?(?:px|rem|em|pt)\\b`),
  },
  // Tailwind arbitrary values: `p-[13px]`, `bg-[#0af]`, `text-[rgb(...)]`
  { kind: "tailwind arbitrary value", re: /(?:^|[\s"'`])[a-z][a-z-]*-\[(?:#|-?\d|rgb|hsl|oklch)/ },
  // Tailwind raw palette instead of a role: `bg-red-500`, `text-white`
  {
    kind: "tailwind raw palette",
    re: new RegExp(
      `(?:^|[\\s"'\`:])(?:${TW_COLOR_UTIL})-(?:(?:${PALETTE})-\\d{2,3}|black|white)(?:/\\d+)?(?=$|[\\s"'\`])`,
    ),
  },
];

/** Raw style literals in one source file (comments ignored). */
export function findRawStyles(source: string): StyleHit[] {
  const hits: StyleHit[] = [];
  stripComments(source)
    .split("\n")
    .forEach((line, i) => {
      for (const { kind, re } of RULES) {
        const m = re.exec(line);
        if (m) hits.push({ line: i + 1, kind, text: m[0].trim() });
      }
    });
  return hits;
}
