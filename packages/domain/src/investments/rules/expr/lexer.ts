/**
 * Tokenizer of the custom-rule expression language (`rules/expr/lexer.py`, grammar in EXPRESSIONS.md).
 *
 * Hand-written, single pass, ASCII only. Every token carries its 1-based column in the expression text.
 * Python indexes strings by code point, so the source is split into code points once (`Array.from`)
 * and every index and column below is a code point offset, never a UTF-16 one.
 */

import { DEFAULT_CONTEXT, Decimal } from "../../../decimal.js";
import {
  MAX_EXPRESSION_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NUMBER_LENGTH,
  MAX_STRING_LENGTH,
  MAX_TOKENS,
} from "./limits.js";

/** A syntax, type or limit error in an expression, at a 1-based `column` of the expression text. */
export class ExpressionError extends Error {
  readonly column: number;

  constructor(message: string, column: number) {
    super(message);
    this.name = "ExpressionError";
    this.column = column;
  }

  /** Python `str(error)`. */
  override toString(): string {
    return `${this.message} (column ${this.column})`;
  }
}

export const TokenType = Object.freeze({
  NUMBER: "number",
  PERCENT: "percent",
  STRING: "string",
  NAME: "name",
  KEYWORD: "keyword",
  OP: "operator",
  LPAREN: "(",
  RPAREN: ")",
  COMMA: ",",
  END: "end",
} as const);
export type TokenType = (typeof TokenType)[keyof typeof TokenType];

export const KEYWORDS: ReadonlySet<string> = new Set(["and", "or", "not", "true", "false"]);
export const COMPARISON_OPERATORS: readonly string[] = ["<=", ">=", "==", "!=", "<", ">"];
const ARITHMETIC_OPERATORS: readonly string[] = ["+", "-", "*", "/"];

// Two-character sequences that look like other languages' operators, with a hint.
const FOREIGN_OPERATORS: ReadonlyMap<string, string> = new Map([
  ["&&", "Use 'and' instead of '&&'"],
  ["||", "Use 'or' instead of '||'"],
  ["**", "Powers are not supported"],
  ["//", "Integer division is not supported; use '/'"],
  ["<>", "Use '!=' to compare for inequality"],
  ["=>", "Use '>=' for 'greater than or equal'"],
  ["=<", "Use '<=' for 'less than or equal'"],
]);

const SINGLE_CHAR_HINTS: ReadonlyMap<string, string> = new Map([
  ["=", "Use '==' to compare; assignment is not supported"],
  ["!", "Use 'not' instead of '!'"],
  ["&", "Use 'and' instead of '&'"],
  ["|", "Use 'or' instead of '|'"],
  ["%", "'%' must directly follow a number (5% = 0.05); the modulo operator is not supported"],
  [".", "Attribute access is not supported"],
  ["[", "Indexing and lists are not supported"],
  ["]", "Indexing and lists are not supported"],
  ["{", "Braces are not supported"],
  ["}", "Braces are not supported"],
  ["^", "Powers and bit operations are not supported"],
  ["~", "Bit operations are not supported"],
  ["@", "The '@' operator is not supported"],
  [";", "Only one expression is allowed; ';' is not supported"],
  [":", "':' is not supported"],
  ["\\", "Backslashes are not supported"],
  ["#", "Comments are not supported"],
  ["$", "'$' is not supported"],
  ["?", "'?' is not supported"],
  ["`", "Backticks are not supported"],
]);

const WHITESPACE: ReadonlySet<string> = new Set([" ", "\t", "\r", "\n"]);

// Python `str.isprintable`: false for categories C* and Z* except the ASCII space. The same
// definition as `NOT_PRINTABLE` of `pyRepr.ts` (module-private there).
const NOT_PRINTABLE = /^[\p{C}\p{Z}]$/u;

export interface Token {
  readonly type: TokenType;
  readonly text: string;
  /** 1-based column of the first character. */
  readonly column: number;
  /** Decimal for NUMBER / PERCENT (a percentage already divided by 100), the content for STRING. */
  readonly value: Decimal | string | null;
}

const HUNDRED = Decimal.fromInt(100);

function token(
  type: TokenType,
  text: string,
  column: number,
  value: Decimal | string | null = null,
) {
  return { type, text, column, value } satisfies Token;
}

// `char.isascii() and char.isdigit()` and friends: the lexer only accepts ASCII letters and digits.
const isAsciiDigit = (ch: string | undefined): boolean =>
  ch !== undefined && ch >= "0" && ch <= "9";
const isAsciiAlpha = (ch: string | undefined): boolean =>
  ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
const isNameChar = (ch: string | undefined): boolean =>
  isAsciiAlpha(ch) || isAsciiDigit(ch) || ch === "_";

/** Splits `source` into tokens ending with an END token. Throws `ExpressionError`. */
export function tokenize(source: string): Token[] {
  const chars = Array.from(source);
  const n = chars.length;
  if (n > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError(
      `Expression is too long (${n} characters, max ${MAX_EXPRESSION_LENGTH})`,
      1,
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < n) {
    const char = chars[i] as string;
    const column = i + 1;
    if (WHITESPACE.has(char)) {
      i += 1;
      continue;
    }
    if (tokens.length >= MAX_TOKENS) {
      throw new ExpressionError(`Expression has too many parts (max ${MAX_TOKENS} tokens)`, column);
    }
    if (isAsciiDigit(char) || (char === "." && isAsciiDigit(chars[i + 1]))) {
      i = readNumber(chars, i, tokens);
      continue;
    }
    if (isAsciiAlpha(char) || char === "_") {
      i = readName(chars, i, tokens);
      continue;
    }
    if (char === '"' || char === "'") {
      i = readString(chars, i, tokens);
      continue;
    }
    // Python `source[i : i + 2]`: one character at the end, which `"<"` / `">"` still match.
    const pair = chars.slice(i, i + 2).join("");
    const foreign = FOREIGN_OPERATORS.get(pair);
    if (foreign !== undefined) throw new ExpressionError(foreign, column);
    if (COMPARISON_OPERATORS.includes(pair)) {
      tokens.push(token(TokenType.OP, pair, column));
      i += 2;
      continue;
    }
    if (char === "<" || char === ">" || ARITHMETIC_OPERATORS.includes(char)) {
      tokens.push(token(TokenType.OP, char, column));
      i += 1;
      continue;
    }
    if (char === "(" || char === ")" || char === ",") {
      const type =
        char === "(" ? TokenType.LPAREN : char === ")" ? TokenType.RPAREN : TokenType.COMMA;
      tokens.push(token(type, char, column));
      i += 1;
      continue;
    }
    const hint = SINGLE_CHAR_HINTS.get(char);
    if (hint !== undefined) throw new ExpressionError(hint, column);
    throw new ExpressionError(`Unexpected character ${describeChar(char)}`, column);
  }
  tokens.push(token(TokenType.END, "", n + 1));
  return tokens;
}

/** Reads a NUMBER or PERCENT token starting at `start`; returns the index after it. */
function readNumber(chars: readonly string[], start: number, tokens: Token[]): number {
  const n = chars.length;
  let i = start;
  while (i < n && isAsciiDigit(chars[i])) i += 1;
  if (i < n && chars[i] === ".") {
    if (!isAsciiDigit(chars[i + 1])) {
      throw new ExpressionError("A decimal point must be followed by digits (e.g. 0.5)", i + 1);
    }
    i += 1;
    while (i < n && isAsciiDigit(chars[i])) i += 1;
    if (i < n && chars[i] === ".") {
      throw new ExpressionError("A number can have only one decimal point", i + 1);
    }
  }
  const text = chars.slice(start, i).join("");
  if (text.length > MAX_NUMBER_LENGTH) {
    throw new ExpressionError(
      `Number is too long (max ${MAX_NUMBER_LENGTH} characters)`,
      start + 1,
    );
  }
  const next = chars[i];
  if (
    (next === "e" || next === "E") &&
    (isAsciiDigit(chars[i + 1]) || chars[i + 1] === "+" || chars[i + 1] === "-")
  ) {
    throw new ExpressionError("Scientific notation is not supported; write the number out", i + 1);
  }
  if (isNameChar(next)) {
    throw new ExpressionError(`Invalid number "${text}${next}..."`, start + 1);
  }
  const value = Decimal.parse(text);
  if (next === "%") {
    // Exact for any number the length limit lets through; the context only matters to mirror
    // Python's `value / 100` (default context, 28 digits).
    tokens.push(
      token(TokenType.PERCENT, `${text}%`, start + 1, value.div(HUNDRED, DEFAULT_CONTEXT)),
    );
    return i + 1;
  }
  tokens.push(token(TokenType.NUMBER, text, start + 1, value));
  return i;
}

/** Reads a NAME or KEYWORD token starting at `start`; returns the index after it. */
function readName(chars: readonly string[], start: number, tokens: Token[]): number {
  const n = chars.length;
  let i = start;
  while (i < n && isNameChar(chars[i])) i += 1;
  // Name characters are ASCII, so UTF-16 length and slicing equal Python's here.
  const text = chars.slice(start, i).join("");
  if (text.startsWith("_")) {
    throw new ExpressionError(
      `Names cannot start with "_" (got "${text.slice(0, MAX_NAME_LENGTH)}")`,
      start + 1,
    );
  }
  if (text.length > MAX_NAME_LENGTH) {
    throw new ExpressionError(`Name is too long (max ${MAX_NAME_LENGTH} characters)`, start + 1);
  }
  tokens.push(token(KEYWORDS.has(text) ? TokenType.KEYWORD : TokenType.NAME, text, start + 1));
  return i;
}

/** Reads a STRING token (single or double quotes, no escapes) starting at `start`. */
function readString(chars: readonly string[], start: number, tokens: Token[]): number {
  const quote = chars[start] as string;
  const n = chars.length;
  let i = start + 1;
  while (i < n && chars[i] !== quote) {
    const char = chars[i] as string;
    if (char === "\r" || char === "\n") {
      throw new ExpressionError(
        "Text must end on the same line (missing closing quote)",
        start + 1,
      );
    }
    if (char === "\\") {
      throw new ExpressionError("Backslash escapes are not supported in text", i + 1);
    }
    if (!isPrintable(char)) {
      throw new ExpressionError(`Unexpected character ${describeChar(char)} in text`, i + 1);
    }
    i += 1;
  }
  if (i >= n) throw new ExpressionError(`Missing closing quote ${quote}`, start + 1);
  const content = chars.slice(start + 1, i);
  if (content.length > MAX_STRING_LENGTH) {
    throw new ExpressionError(`Text is too long (max ${MAX_STRING_LENGTH} characters)`, start + 1);
  }
  tokens.push(
    token(TokenType.STRING, chars.slice(start, i + 1).join(""), start + 1, content.join("")),
  );
  return i + 1;
}

/** Python `char.isprintable()` for one code point. */
function isPrintable(char: string): boolean {
  return char === " " || !NOT_PRINTABLE.test(char);
}

/** `_describe_char`: a printable ASCII character in quotes, anything else as `U+XXXX`. */
function describeChar(char: string): string {
  const cp = char.codePointAt(0) as number;
  if (cp >= 0x20 && cp < 0x7f) return `"${char}"`;
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}
