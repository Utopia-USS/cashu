/**
 * Python `re` patterns (str patterns) as JavaScript `u` regexes with the same matches.
 *
 * JavaScript's `\w`, `\d`, `\b` and `\s` are ASCII (or, for `\s`, a different set) even with the `u`
 * flag; Python's are Unicode. Checked over every code point against Python 3.14 (Unicode 16.0, the
 * same as Node's ICU): Python `\w` = `[\p{L}\p{N}_]`, `\d` = `\p{Nd}`, `\s` = `PY_WS`. IGNORECASE
 * equals the `iu` flags for the ASCII and Polish letters except the i-letters: Python matches each of
 * `i`, `I`, `İ` (U+0130) and `ı` (U+0131) against all four, JavaScript pairs only `i` / `I`. Python
 * `.` excludes only `\n` (JavaScript also `\r`, U+2028, U+2029) and `$` also matches before a final
 * `\n`. `pyRegex` rewrites a Python pattern source accordingly, so ports can keep the Python source
 * text verbatim (and byte-hash it against the Python module).
 */

import { PY_WS } from "./text.js";

/** Python `\w` as a character class body. */
export const PY_W = "\\p{L}\\p{N}_";
/** Python `\d` (Unicode decimal digits). */
export const PY_D = "\\p{Nd}";
/** Python `\b`: a boundary between Python word and non-word characters. */
export const PY_B = `(?:(?<=[${PY_W}])(?![${PY_W}])|(?<![${PY_W}])(?=[${PY_W}]))`;
/** Python `\B`. */
const PY_NOT_B = `(?:(?<=[${PY_W}])(?=[${PY_W}])|(?<![${PY_W}])(?![${PY_W}]))`;
/**
 * Python `[^\W\d_]` (a word character that is neither a digit nor `_`: letters and the non-decimal
 * numerics) as a character class body. The translator accepts this one idiom with `\W` in a class.
 */
export const PY_LETTER = "\\p{L}\\p{Nl}\\p{No}";
/** Python `$` without MULTILINE: the end, or just before a newline that ends the string. */
export const PY_END = "(?=\\n?$)";
/** The four letters Python IGNORECASE treats as one class (`iu` pairs only `i` / `I`). */
export const PY_IC_I = "[iIİı]";

const SYNTAX_RE = /[\\^$.*+?()[\]{}|/]/g;

/**
 * A literal text inside a `u` pattern (escapes the syntax characters only; Python `re.escape` also
 * escapes other punctuation, which matches the same literal).
 */
export function escapeRe(text: string): string {
  return text.replace(SYNTAX_RE, "\\$&");
}

/**
 * A literal text for a case-insensitive (`iu`) pattern with Python IGNORECASE semantics: escaped,
 * and every i-letter widened to `PY_IC_I`.
 */
export function ignoreCaseLiteral(text: string): string {
  return escapeRe(text).replace(/[iIİı]/gu, PY_IC_I);
}

/**
 * A `u` regex from a JavaScript source composed of the building blocks above (`PY_W`, `PY_D`,
 * `PY_B`, `PY_END`, `PY_IC_I`, `PY_WS`, `PY_LETTER`); `pyRegex` translates a Python source instead.
 */
export function uRegex(source: string, flags = ""): RegExp {
  return new RegExp(source, `u${flags}`);
}

const I_LETTERS = new Set(["i", "I", "İ", "ı"]);
/** Characters JavaScript `u` patterns accept escaped (`\x`): the syntax characters and `/`. */
const SYNTAX = new Set("^$\\.*+?()[]{}|/".split(""));
const QUANTIFIER = /^\{\d*(?:,\d*)?\}/;

export class PyRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PyRegexError";
  }
}

/** A code point as a `u`-mode escape (`\u{...}`), for literals JavaScript would refuse escaped. */
function literal(ch: string): string {
  return `\\u{${(ch.codePointAt(0) as number).toString(16)}}`;
}

interface Translation {
  readonly source: string;
  readonly ignoreCase: boolean;
}

/**
 * Translates a Python pattern source (the subset the ports use: groups, lookarounds, classes,
 * quantifiers, the escapes `\w \W \s \S \d \D \b \B \A \Z \z \xhh \uhhhh`, a leading `(?i)`) to a
 * JavaScript `u` pattern source. Throws `PyRegexError` on syntax it does not translate.
 */
export function translatePyPattern(python: string): Translation {
  let pattern = python;
  let ignoreCase = false;
  if (pattern.startsWith("(?i)")) {
    ignoreCase = true;
    pattern = pattern.slice(4);
  }
  if (/\(\?[aiLmsux]+\)/.test(pattern)) {
    throw new PyRegexError("inline flags other than a leading (?i) are not supported");
  }
  const chars = Array.from(pattern);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (ch === "\\") {
      const next = chars[i + 1];
      if (next === undefined) throw new PyRegexError("trailing backslash");
      i += 2;
      switch (next) {
        case "w":
          out += `[${PY_W}]`;
          break;
        case "W":
          out += `[^${PY_W}]`;
          break;
        case "s":
          out += `[${PY_WS}]`;
          break;
        case "S":
          out += `[^${PY_WS}]`;
          break;
        case "d":
          out += PY_D;
          break;
        case "D":
          out += `\\P{Nd}`;
          break;
        case "b":
          out += PY_B;
          break;
        case "B":
          out += PY_NOT_B;
          break;
        case "A":
          out += "^";
          break;
        case "Z":
        case "z":
          out += "$";
          break;
        case "x":
        case "u":
        case "n":
        case "t":
        case "r":
        case "f":
        case "v":
          out += `\\${next}`;
          break;
        default:
          if (/[0-9A-Za-z]/.test(next)) throw new PyRegexError(`unsupported escape \\${next}`);
          out += SYNTAX.has(next) ? `\\${next}` : literal(next);
      }
      continue;
    }
    if (ch === "[") {
      const [body, end] = translateClass(chars, i, ignoreCase);
      out += body;
      i = end;
      continue;
    }
    if (ch === "{") {
      const rest = chars.slice(i, i + 24).join("");
      const quantifier = QUANTIFIER.exec(rest);
      if (quantifier) {
        out += quantifier[0];
        i += Array.from(quantifier[0]).length;
      } else {
        out += "\\{";
        i++;
      }
      continue;
    }
    i++;
    if (ch === ".") out += "[^\\n]";
    else if (ch === "$") out += PY_END;
    else if (ch === "}" || ch === "]") out += `\\${ch}`;
    else if (ignoreCase && I_LETTERS.has(ch)) out += PY_IC_I;
    else out += ch;
  }
  return { source: out, ignoreCase };
}

interface ClassAtom {
  /** The atom in JavaScript class syntax. */
  readonly js: string;
  /** Its code point, or null for a class escape (`\w`, `\s`, `\d`). */
  readonly cp: number | null;
  readonly next: number;
}

/** One class member at `chars[i]`: a literal or an escape. */
function classAtom(chars: readonly string[], i: number): ClassAtom {
  const ch = chars[i] as string;
  if (ch !== "\\") {
    const js = ch === "[" || ch === "]" || ch === "/" || ch === "-" || ch === "\\" ? `\\${ch}` : ch;
    return { js, cp: ch.codePointAt(0) as number, next: i + 1 };
  }
  const next = chars[i + 1];
  if (next === undefined) throw new PyRegexError("trailing backslash in a class");
  if (next === "w") return { js: PY_W, cp: null, next: i + 2 };
  if (next === "s") return { js: PY_WS, cp: null, next: i + 2 };
  if (next === "d") return { js: PY_D, cp: null, next: i + 2 };
  if ("WSDbB".includes(next)) throw new PyRegexError(`\\${next} inside a class`);
  const hex = (n: number): ClassAtom => {
    const digits = chars.slice(i + 2, i + 2 + n).join("");
    if (!new RegExp(`^[0-9A-Fa-f]{${n}}$`).test(digits)) throw new PyRegexError("bad hex escape");
    const cp = Number.parseInt(digits, 16);
    return { js: literal(String.fromCodePoint(cp)), cp, next: i + 2 + n };
  };
  if (next === "x") return hex(2);
  if (next === "u") return hex(4);
  const controls: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, v: 11 };
  const control = controls[next];
  if (control !== undefined) return { js: `\\${next}`, cp: control, next: i + 2 };
  if (/[0-9A-Za-z]/.test(next)) throw new PyRegexError(`unsupported escape \\${next}`);
  return {
    js: next === "-" || SYNTAX.has(next) ? `\\${next}` : literal(next),
    cp: next.codePointAt(0) as number,
    next: i + 2,
  };
}

const IC_I_POINTS = [0x49, 0x69, 0x130, 0x131];

/** A character class starting at `chars[start] === "["`: its JS form and the index after it. */
function translateClass(
  chars: readonly string[],
  start: number,
  ignoreCase: boolean,
): [string, number] {
  if (chars.slice(start, start + 8).join("") === "[^\\W\\d_]") return [`[${PY_LETTER}]`, start + 8];
  let i = start + 1;
  let out = "[";
  if (chars[i] === "^") {
    out += "^";
    i++;
  }
  let first = true;
  let hasI = false;
  while (i < chars.length) {
    if (chars[i] === "]" && !first) {
      if (ignoreCase && hasI) out += "İı";
      return [`${out}]`, i + 1];
    }
    first = false;
    const atom = classAtom(chars, i);
    i = atom.next;
    if (
      atom.cp !== null &&
      chars[i] === "-" &&
      chars[i + 1] !== undefined &&
      chars[i + 1] !== "]"
    ) {
      const end = classAtom(chars, i + 1);
      if (end.cp === null) throw new PyRegexError("a class escape cannot end a range");
      const lo = atom.cp;
      const hi = end.cp;
      if (IC_I_POINTS.some((cp) => lo <= cp && cp <= hi)) hasI = true;
      out += `${atom.js}-${end.js}`;
      i = end.next;
      continue;
    }
    if (atom.cp !== null && IC_I_POINTS.includes(atom.cp)) hasI = true;
    out += atom.js;
  }
  throw new PyRegexError("unterminated character class");
}

/** A Python pattern as a JavaScript regex (`extraFlags`: e.g. `g`). */
export function pyRegex(python: string, extraFlags = ""): RegExp {
  const { source, ignoreCase } = translatePyPattern(python);
  return new RegExp(source, `u${ignoreCase ? "i" : ""}${extraFlags}`);
}
