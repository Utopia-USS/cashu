/**
 * Text normalisation identical to Python's `core/text.py` and the `str` methods the call sites use.
 *
 * Python and JavaScript disagree on what whitespace is (`str.isspace` / regex `\s` include U+001C-U+001F
 * and U+0085 but not U+FEFF; JS `\s` is the opposite) and JS has no `unicodedata.combining` or
 * `unicodedata.decimal`, so those come as tables generated from Python (Unicode 16.0, the version of
 * both Python 3.14 and Node's ICU). The vector suite re-checks every table and every code point
 * against hashes recorded from Python (text.jsonl, text.codepoints.exhaustive.test.ts).
 */

/** Code points for which Python `str.isspace()` (and regex `\s` on str) is true. */
export const PY_WHITESPACE: readonly number[] = [
  0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002,
  0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
  0x3000,
];

/** Python's `\s` as a JS character class body, for porting regexes (`new RegExp(`[${PY_WS}]+`, "gu")`). */
export const PY_WS =
  "\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const PY_SPACE_SET: ReadonlySet<number> = new Set(PY_WHITESPACE);

/** Python `chr(cp).isspace()`. */
export function isPySpace(cp: number): boolean {
  return PY_SPACE_SET.has(cp);
}

/** Inclusive ranges `[from0, to0, from1, to1, ...]` of code points with `unicodedata.combining(c) != 0`. */
const COMBINING_RANGES: readonly number[] = [
  0x300, 0x34e, 0x350, 0x36f, 0x483, 0x487, 0x591, 0x5bd, 0x5bf, 0x5bf, 0x5c1, 0x5c2, 0x5c4, 0x5c5,
  0x5c7, 0x5c7, 0x610, 0x61a, 0x64b, 0x65f, 0x670, 0x670, 0x6d6, 0x6dc, 0x6df, 0x6e4, 0x6e7, 0x6e8,
  0x6ea, 0x6ed, 0x711, 0x711, 0x730, 0x74a, 0x7eb, 0x7f3, 0x7fd, 0x7fd, 0x816, 0x819, 0x81b, 0x823,
  0x825, 0x827, 0x829, 0x82d, 0x859, 0x85b, 0x897, 0x89f, 0x8ca, 0x8e1, 0x8e3, 0x8ff, 0x93c, 0x93c,
  0x94d, 0x94d, 0x951, 0x954, 0x9bc, 0x9bc, 0x9cd, 0x9cd, 0x9fe, 0x9fe, 0xa3c, 0xa3c, 0xa4d, 0xa4d,
  0xabc, 0xabc, 0xacd, 0xacd, 0xb3c, 0xb3c, 0xb4d, 0xb4d, 0xbcd, 0xbcd, 0xc3c, 0xc3c, 0xc4d, 0xc4d,
  0xc55, 0xc56, 0xcbc, 0xcbc, 0xccd, 0xccd, 0xd3b, 0xd3c, 0xd4d, 0xd4d, 0xdca, 0xdca, 0xe38, 0xe3a,
  0xe48, 0xe4b, 0xeb8, 0xeba, 0xec8, 0xecb, 0xf18, 0xf19, 0xf35, 0xf35, 0xf37, 0xf37, 0xf39, 0xf39,
  0xf71, 0xf72, 0xf74, 0xf74, 0xf7a, 0xf7d, 0xf80, 0xf80, 0xf82, 0xf84, 0xf86, 0xf87, 0xfc6, 0xfc6,
  0x1037, 0x1037, 0x1039, 0x103a, 0x108d, 0x108d, 0x135d, 0x135f, 0x1714, 0x1715, 0x1734, 0x1734,
  0x17d2, 0x17d2, 0x17dd, 0x17dd, 0x18a9, 0x18a9, 0x1939, 0x193b, 0x1a17, 0x1a18, 0x1a60, 0x1a60,
  0x1a75, 0x1a7c, 0x1a7f, 0x1a7f, 0x1ab0, 0x1abd, 0x1abf, 0x1ace, 0x1b34, 0x1b34, 0x1b44, 0x1b44,
  0x1b6b, 0x1b73, 0x1baa, 0x1bab, 0x1be6, 0x1be6, 0x1bf2, 0x1bf3, 0x1c37, 0x1c37, 0x1cd0, 0x1cd2,
  0x1cd4, 0x1ce0, 0x1ce2, 0x1ce8, 0x1ced, 0x1ced, 0x1cf4, 0x1cf4, 0x1cf8, 0x1cf9, 0x1dc0, 0x1dff,
  0x20d0, 0x20dc, 0x20e1, 0x20e1, 0x20e5, 0x20f0, 0x2cef, 0x2cf1, 0x2d7f, 0x2d7f, 0x2de0, 0x2dff,
  0x302a, 0x302f, 0x3099, 0x309a, 0xa66f, 0xa66f, 0xa674, 0xa67d, 0xa69e, 0xa69f, 0xa6f0, 0xa6f1,
  0xa806, 0xa806, 0xa82c, 0xa82c, 0xa8c4, 0xa8c4, 0xa8e0, 0xa8f1, 0xa92b, 0xa92d, 0xa953, 0xa953,
  0xa9b3, 0xa9b3, 0xa9c0, 0xa9c0, 0xaab0, 0xaab0, 0xaab2, 0xaab4, 0xaab7, 0xaab8, 0xaabe, 0xaabf,
  0xaac1, 0xaac1, 0xaaf6, 0xaaf6, 0xabed, 0xabed, 0xfb1e, 0xfb1e, 0xfe20, 0xfe2f, 0x101fd, 0x101fd,
  0x102e0, 0x102e0, 0x10376, 0x1037a, 0x10a0d, 0x10a0d, 0x10a0f, 0x10a0f, 0x10a38, 0x10a3a, 0x10a3f,
  0x10a3f, 0x10ae5, 0x10ae6, 0x10d24, 0x10d27, 0x10d69, 0x10d6d, 0x10eab, 0x10eac, 0x10efd, 0x10eff,
  0x10f46, 0x10f50, 0x10f82, 0x10f85, 0x11046, 0x11046, 0x11070, 0x11070, 0x1107f, 0x1107f, 0x110b9,
  0x110ba, 0x11100, 0x11102, 0x11133, 0x11134, 0x11173, 0x11173, 0x111c0, 0x111c0, 0x111ca, 0x111ca,
  0x11235, 0x11236, 0x112e9, 0x112ea, 0x1133b, 0x1133c, 0x1134d, 0x1134d, 0x11366, 0x1136c, 0x11370,
  0x11374, 0x113ce, 0x113d0, 0x11442, 0x11442, 0x11446, 0x11446, 0x1145e, 0x1145e, 0x114c2, 0x114c3,
  0x115bf, 0x115c0, 0x1163f, 0x1163f, 0x116b6, 0x116b7, 0x1172b, 0x1172b, 0x11839, 0x1183a, 0x1193d,
  0x1193e, 0x11943, 0x11943, 0x119e0, 0x119e0, 0x11a34, 0x11a34, 0x11a47, 0x11a47, 0x11a99, 0x11a99,
  0x11c3f, 0x11c3f, 0x11d42, 0x11d42, 0x11d44, 0x11d45, 0x11d97, 0x11d97, 0x11f41, 0x11f42, 0x1612f,
  0x1612f, 0x16af0, 0x16af4, 0x16b30, 0x16b36, 0x16ff0, 0x16ff1, 0x1bc9e, 0x1bc9e, 0x1d165, 0x1d169,
  0x1d16d, 0x1d172, 0x1d17b, 0x1d182, 0x1d185, 0x1d18b, 0x1d1aa, 0x1d1ad, 0x1d242, 0x1d244, 0x1e000,
  0x1e006, 0x1e008, 0x1e018, 0x1e01b, 0x1e021, 0x1e023, 0x1e024, 0x1e026, 0x1e02a, 0x1e08f, 0x1e08f,
  0x1e130, 0x1e136, 0x1e2ae, 0x1e2ae, 0x1e2ec, 0x1e2ef, 0x1e4ec, 0x1e4ef, 0x1e5ee, 0x1e5ef, 0x1e8d0,
  0x1e8d6, 0x1e944, 0x1e94a,
];

/** First code point (the digit zero) of every run of ten Unicode decimal digits (category Nd). */
export const ND_ZEROS: readonly number[] = [
  0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6,
  0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80, 0x1a90, 0x1b50,
  0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0,
  0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0, 0x11450, 0x114d0, 0x11650, 0x116c0,
  0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16130,
  0x16a60, 0x16ac0, 0x16b50, 0x16d70, 0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140,
  0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

/** Python `unicodedata.combining(chr(cp)) != 0` (canonical combining class is not 0). */
export function isCombining(cp: number): boolean {
  let lo = 0;
  let hi = COMBINING_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const from = COMBINING_RANGES[2 * mid] as number;
    const to = COMBINING_RANGES[2 * mid + 1] as number;
    if (cp < from) hi = mid - 1;
    else if (cp > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Python `unicodedata.decimal(chr(cp), -1)`: the digit value of a Unicode decimal digit, else -1. */
export function unicodeDecimal(cp: number): number {
  let lo = 0;
  let hi = ND_ZEROS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const zero = ND_ZEROS[mid] as number;
    if (cp < zero) hi = mid - 1;
    else if (cp > zero + 9) lo = mid + 1;
    else return cp - zero;
  }
  return -1;
}

/**
 * Python `s.strip()` (no argument: strips `str.isspace` characters). Scans UTF-16 code units: every
 * Python whitespace character is a single BMP code unit and no surrogate is whitespace, so a scan by
 * code unit stops exactly where a scan by code point would, without splitting the string into an
 * array of code points (the hot path of `normalizeText`).
 */
export function pyStrip(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && PY_SPACE_SET.has(s.charCodeAt(start))) start++;
  while (end > start && PY_SPACE_SET.has(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

/** Python `s.split()` (no argument): runs of whitespace separate, no empty strings. */
export function pySplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (isPySpace(ch.codePointAt(0) as number)) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Python `len(s)`: the length in code points (a lone surrogate counts as one). */
export function pyLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Python `s.upper()` (full case mapping, locale independent). */
export function pyUpper(s: string): string {
  return s.toUpperCase();
}

/** Python `s.lower()` (full case mapping incl. the final sigma rule, locale independent). */
export function pyLower(s: string): string {
  return s.toLowerCase();
}

/** Every code point with `unicodedata.combining(c) != 0`, as one class (built from `COMBINING_RANGES`). */
const COMBINING_RE = new RegExp(
  `[${Array.from({ length: COMBINING_RANGES.length / 2 }, (_, i) => {
    const from = COMBINING_RANGES[2 * i] as number;
    const to = COMBINING_RANGES[2 * i + 1] as number;
    const lo = `\\u{${from.toString(16)}}`;
    return from === to ? lo : `${lo}-\\u{${to.toString(16)}}`;
  }).join("")}]`,
  "gu",
);
const WS_RUN = new RegExp(`[${PY_WS}]+`, "gu");
/** `ł`/`Ł` have no NFKD decomposition: replaced by hand, in one pass. */
const L_STROKE = /[łŁ]/g;
const unstroke = (ch: string): string => (ch === "ł" ? "l" : "L");

/**
 * `core/text.py:normalize_text`: upper case, diacritics stripped (NFKD minus combining marks, with
 * `ł`/`Ł` special-cased), whitespace runs collapsed to one space and trimmed. Empty for null/"".
 */
export function normalizeText(value: string | null | undefined): string {
  if (!value) return "";
  const replaced = value.replace(L_STROKE, unstroke).normalize("NFKD");
  return pyUpper(pyStrip(replaced.replace(COMBINING_RE, "").replace(WS_RUN, " ")));
}

/** Line boundaries of Python `str.splitlines()` (`\r\n` counts as one). */
const LINE_BREAKS: ReadonlySet<number> = new Set([
  0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

/** Python `s.splitlines()`: no line ends kept, no trailing empty line. */
export function pySplitlines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.charCodeAt(i);
    if (!LINE_BREAKS.has(cp)) {
      i++;
      continue;
    }
    out.push(text.slice(start, i));
    i += cp === 0x0d && text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
    start = i;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Python `s.strip(chars)` / `s.lstrip(chars)` / `s.rstrip(chars)` (code points of `chars`). */
export function pyStripChars(
  value: string,
  chars: string,
  side: "both" | "left" | "right" = "both",
): string {
  const set = new Set(Array.from(chars));
  const cps = Array.from(value);
  let start = 0;
  let end = cps.length;
  if (side !== "right") while (start < end && set.has(cps[start] as string)) start++;
  if (side !== "left") while (end > start && set.has(cps[end - 1] as string)) end--;
  return cps.slice(start, end).join("");
}

/**
 * Inclusive ranges of the code points with Numeric_Type=Digit that are not decimal digits
 * (superscripts, circled digits, ...): `str.isdigit()` is true for them and for every Nd digit.
 */
const DIGIT_ONLY_RANGES: readonly number[] = [
  0xb2, 0xb3, 0xb9, 0xb9, 0x1369, 0x1371, 0x19da, 0x19da, 0x2070, 0x2070, 0x2074, 0x2079, 0x2080,
  0x2089, 0x2460, 0x2468, 0x2474, 0x247c, 0x2488, 0x2490, 0x24ea, 0x24ea, 0x24f5, 0x24fd, 0x24ff,
  0x24ff, 0x2776, 0x277e, 0x2780, 0x2788, 0x278a, 0x2792, 0x10a40, 0x10a43, 0x10e60, 0x10e68,
  0x11052, 0x1105a, 0x1f100, 0x1f10a,
];

/** Python `chr(cp).isdigit()`. */
export function pyIsDigit(cp: number): boolean {
  if (unicodeDecimal(cp) >= 0) return true;
  for (let i = 0; i < DIGIT_ONLY_RANGES.length; i += 2) {
    if (cp >= (DIGIT_ONLY_RANGES[i] as number) && cp <= (DIGIT_ONLY_RANGES[i + 1] as number)) {
      return true;
    }
  }
  return false;
}
