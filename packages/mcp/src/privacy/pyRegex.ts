/**
 * Building blocks for porting Python `re` patterns (str patterns, default flags) to JavaScript `u`
 * regexes with the same matches. JavaScript's `\d`, `\w`, `\s` and `\b` are ASCII (or, for `\s`, a
 * different set) even with the `u` flag; Python's are Unicode. Checked over every code point against
 * Python 3.14 (Unicode 16.0, the same as Node's ICU): Python `\w` = `[\p{L}\p{N}_]`, `\d` = `\p{Nd}`,
 * `\s` = `PY_WS` (from `@cashu/domain`); IGNORECASE equals the `iu` flags for every literal except
 * the four i-letters, which Python treats as one class (`IC_I`). `privacy.vectors.test.ts` replays the
 * Python-generated vectors that pin all of this.
 */

import { PY_WS } from "@cashu/domain";

/** Python `\w` as a character class body. */
export const W = "\\p{L}\\p{N}_";
/** Python `\d` (Unicode decimal digits). */
export const D = "\\p{Nd}";
/** Python `\s` as a character class body. */
export const S = PY_WS;
/** Python `\b` (a boundary between Python word and non-word characters). */
export const B = `(?:(?<=[${W}])(?![${W}])|(?<![${W}])(?=[${W}]))`;
/** Python `$` without MULTILINE: the end, or just before a newline that ends the string. */
export const END = "(?=\\n?$)";
/**
 * Python IGNORECASE matches each of `i`, `I`, `İ` (U+0130) and `ı` (U+0131) against all four;
 * JavaScript's `iu` pairs only `i` / `I`. Use this class for an `i` inside a case-insensitive group.
 */
export const IC_I = "[iIİı]";

const SYNTAX = /[\\^$.*+?()[\]{}|/]/g;

/** `re.escape` for a pattern built with the `u` flag (only syntax characters are escaped). */
export function escapeRe(text: string): string {
  return text.replace(SYNTAX, "\\$&");
}

/**
 * A literal text for a case-insensitive (`iu`) pattern with Python IGNORECASE semantics: escaped,
 * and every i-letter widened to `IC_I`.
 */
export function ignoreCaseLiteral(text: string): string {
  return escapeRe(text).replace(/[iIİı]/gu, IC_I);
}

/** A `u` regex (the only kind the privacy layer builds). */
export function pyRe(source: string, flags = ""): RegExp {
  return new RegExp(source, `u${flags}`);
}
