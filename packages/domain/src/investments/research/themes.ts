/**
 * Old free-text themes (`scoring.clean_theme` / `scoring.theme_key`): stored notes and runs may still
 * carry one; new market notes take a segment (P5).
 */

import { pyCasefold } from "../../casefold.js";
import { isCombining, PY_WS, pyStrip } from "../../text.js";

const SPACES = new RegExp(`[${PY_WS}]+`, "gu");
const NOT_SLUG = /[^a-z0-9]+/g;
const FOLD: Readonly<Record<string, string>> = Object.freeze({
  ł: "l",
  Ł: "L",
  ß: "ss",
  ø: "o",
  Ø: "O",
  đ: "d",
  Đ: "D",
});
const FOLD_CHARS = /[łŁßøØđĐ]/g;

/** A theme as stored: trimmed, inner whitespace collapsed (null when empty). */
export function cleanTheme(theme: string | null | undefined): string | null {
  if (theme === null || theme === undefined) return null;
  const text = pyStrip(theme.replace(SPACES, " "));
  return text || null;
}

/**
 * Grouping key of a theme: case- and accent-insensitive slug (`Półprzewodniki` and
 * `polprzewodniki` are one theme).
 */
export function themeKey(theme: string): string {
  const folded = (cleanTheme(theme) ?? "")
    .replace(FOLD_CHARS, (ch) => FOLD[ch] as string)
    .normalize("NFKD");
  let kept = "";
  for (const ch of folded) if (!isCombining(ch.codePointAt(0) as number)) kept += ch;
  const slug = pyCasefold(kept)
    .replace(NOT_SLUG, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "theme";
}
