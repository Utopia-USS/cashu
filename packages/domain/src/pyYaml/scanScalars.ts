/**
 * PyYAML's scalar scanners (`scanner.py`): block scalars (`|` / `>` with chomping and indentation
 * indicators), single- and double-quoted scalars (escapes, line folding, document separators) and
 * plain scalars (multi-line folding, the flow-context restrictions).
 */

import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import { NUL_BLANK_BREAK, type Reader, type ScanState } from "./reader.js";
import type { Token } from "./tokens.js";

const BREAKS = "\r\n\x85\u2028\u2029";
const NUL_OR_BREAK = "\0\r\n\x85\u2028\u2029";
/** NUL, space or a line break (the end of a directive / block scalar header token). */
const NUL_SPACE_BREAK = "\0 \r\n\x85\u2028\u2029";
const HEX = "0123456789ABCDEFabcdef";
const DIGITS = "0123456789";

/** `list.extend` without spreading (a long run of blank lines would overflow the argument limit). */
function extend(target: string[], items: readonly string[]): void {
  for (const item of items) target.push(item);
}

type ScalarToken = Extract<Token, { id: "<scalar>" }>;

function scalarToken(
  value: string,
  plain: boolean,
  startMark: YamlMark,
  endMark: YamlMark,
  style: ScalarToken["style"],
): ScalarToken {
  return { id: "<scalar>", value, plain, style, startMark, endMark };
}

/** A document separator `---` / `...` at the current position (followed by a blank or end). */
function atDocumentSeparator(r: Reader): boolean {
  const prefix = r.prefix(3);
  return (prefix === "---" || prefix === "...") && NUL_BLANK_BREAK.includes(r.peek(3));
}

// Block scalars.

export function scanBlockScalar(s: ScanState, style: "|" | ">"): ScalarToken {
  const r = s.reader;
  const folded = style === ">";
  const chunks: string[] = [];
  const startMark = r.getMark();
  // Scan the header.
  r.forward();
  const { chomping, increment } = scanBlockScalarIndicators(r, startMark);
  scanBlockScalarIgnoredLine(r, startMark);
  // Determine the indentation level and go to the first non-empty line.
  const minIndent = Math.max(s.indent + 1, 1);
  let indent: number;
  let breaks: string[];
  let endMark: YamlMark;
  if (increment === null) {
    const found = scanBlockScalarIndentation(r);
    breaks = found.chunks;
    endMark = found.endMark;
    indent = Math.max(minIndent, found.maxIndent);
  } else {
    indent = minIndent + increment - 1;
    ({ chunks: breaks, endMark } = scanBlockScalarBreaks(r, indent));
  }
  let lineBreak = "";
  // Scan the inner part of the block scalar.
  while (r.column === indent && r.peek() !== "\0") {
    extend(chunks, breaks);
    const leadingNonSpace = r.peek() !== " " && r.peek() !== "\t";
    let length = 0;
    while (!NUL_OR_BREAK.includes(r.peek(length))) length += 1;
    chunks.push(r.prefix(length));
    r.forward(length);
    lineBreak = r.scanLineBreak();
    ({ chunks: breaks, endMark } = scanBlockScalarBreaks(r, indent));
    if (r.column === indent && r.peek() !== "\0") {
      // Folding as the specification has it (not Clark Evans's interpretation).
      if (folded && lineBreak === "\n" && leadingNonSpace && !" \t".includes(r.peek())) {
        if (breaks.length === 0) chunks.push(" ");
      } else {
        chunks.push(lineBreak);
      }
    } else {
      break;
    }
  }
  // Chomp the tail.
  if (chomping !== false) chunks.push(lineBreak);
  if (chomping === true) extend(chunks, breaks);
  return scalarToken(chunks.join(""), false, startMark, endMark, style);
}

function scanBlockScalarIndicators(
  r: Reader,
  startMark: YamlMark,
): { chomping: boolean | null; increment: number | null } {
  let chomping: boolean | null = null;
  let increment: number | null = null;
  const zero = () =>
    markedError(
      "while scanning a block scalar",
      startMark,
      "expected indentation indicator in the range 1-9, but found 0",
      r.getMark(),
    );
  let ch = r.peek();
  if (ch === "+" || ch === "-") {
    chomping = ch === "+";
    r.forward();
    ch = r.peek();
    if (DIGITS.includes(ch)) {
      increment = Number(ch);
      if (increment === 0) throw zero();
      r.forward();
    }
  } else if (DIGITS.includes(ch)) {
    increment = Number(ch);
    if (increment === 0) throw zero();
    r.forward();
    ch = r.peek();
    if (ch === "+" || ch === "-") {
      chomping = ch === "+";
      r.forward();
    }
  }
  ch = r.peek();
  if (!NUL_SPACE_BREAK.includes(ch)) {
    throw markedError(
      "while scanning a block scalar",
      startMark,
      `expected chomping or indentation indicators, but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  }
  return { chomping, increment };
}

function scanBlockScalarIgnoredLine(r: Reader, startMark: YamlMark): void {
  while (r.peek() === " ") r.forward();
  if (r.peek() === "#") {
    while (!NUL_OR_BREAK.includes(r.peek())) r.forward();
  }
  const ch = r.peek();
  if (!NUL_OR_BREAK.includes(ch)) {
    throw markedError(
      "while scanning a block scalar",
      startMark,
      `expected a comment or a line break, but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  }
  r.scanLineBreak();
}

function scanBlockScalarIndentation(r: Reader): {
  chunks: string[];
  maxIndent: number;
  endMark: YamlMark;
} {
  const chunks: string[] = [];
  let maxIndent = 0;
  let endMark = r.getMark();
  while (` ${BREAKS}`.includes(r.peek())) {
    if (r.peek() !== " ") {
      chunks.push(r.scanLineBreak());
      endMark = r.getMark();
    } else {
      r.forward();
      if (r.column > maxIndent) maxIndent = r.column;
    }
  }
  return { chunks, maxIndent, endMark };
}

function scanBlockScalarBreaks(r: Reader, indent: number): { chunks: string[]; endMark: YamlMark } {
  const chunks: string[] = [];
  let endMark = r.getMark();
  while (r.column < indent && r.peek() === " ") r.forward();
  while (BREAKS.includes(r.peek())) {
    chunks.push(r.scanLineBreak());
    endMark = r.getMark();
    while (r.column < indent && r.peek() === " ") r.forward();
  }
  return { chunks, endMark };
}

// Flow (quoted) scalars. Indentation is not checked inside quotes, only document separators.

const ESCAPE_REPLACEMENTS: Readonly<Record<string, string>> = {
  "0": "\0",
  a: "\x07",
  b: "\x08",
  t: "\x09",
  "\t": "\x09",
  n: "\x0A",
  v: "\x0B",
  f: "\x0C",
  r: "\x0D",
  e: "\x1B",
  " ": "\x20",
  '"': '"',
  "\\": "\\",
  "/": "/",
  N: "\x85",
  _: "\xA0",
  L: "\u2028",
  P: "\u2029",
};

const ESCAPE_CODES: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 };

export function scanFlowScalar(r: Reader, style: "'" | '"'): ScalarToken {
  const double = style === '"';
  const chunks: string[] = [];
  const startMark = r.getMark();
  const quote = r.peek();
  r.forward();
  scanFlowScalarNonSpaces(r, double, startMark, chunks);
  while (r.peek() !== quote) {
    scanFlowScalarSpaces(r, startMark, chunks);
    scanFlowScalarNonSpaces(r, double, startMark, chunks);
  }
  r.forward();
  return scalarToken(chunks.join(""), false, startMark, r.getMark(), style);
}

function scanFlowScalarNonSpaces(
  r: Reader,
  double: boolean,
  startMark: YamlMark,
  chunks: string[],
): void {
  for (;;) {
    let length = 0;
    while (!"'\"\\\0 \t\r\n\x85\u2028\u2029".includes(r.peek(length))) length += 1;
    if (length > 0) {
      chunks.push(r.prefix(length));
      r.forward(length);
    }
    let ch = r.peek();
    if (!double && ch === "'" && r.peek(1) === "'") {
      chunks.push("'");
      r.forward(2);
    } else if ((double && ch === "'") || (!double && (ch === '"' || ch === "\\"))) {
      chunks.push(ch);
      r.forward();
    } else if (double && ch === "\\") {
      r.forward();
      ch = r.peek();
      const replacement = Object.hasOwn(ESCAPE_REPLACEMENTS, ch)
        ? ESCAPE_REPLACEMENTS[ch]
        : undefined;
      const codeLength = Object.hasOwn(ESCAPE_CODES, ch) ? ESCAPE_CODES[ch] : undefined;
      if (replacement !== undefined) {
        chunks.push(replacement);
        r.forward();
      } else if (codeLength !== undefined) {
        r.forward();
        for (let k = 0; k < codeLength; k++) {
          if (!HEX.includes(r.peek(k))) {
            throw markedError(
              "while scanning a double-quoted scalar",
              startMark,
              `expected escape sequence of ${codeLength} hexadecimal numbers, but found ${pyReprStr(r.peek(k))}`,
              r.getMark(),
            );
          }
        }
        const code = Number.parseInt(r.prefix(codeLength), 16);
        if (code > 0x10ffff) {
          // Python's `chr(code)` raises ValueError here (not a YAMLError, so `yaml.compose` lets it
          // escape). The port reports it as a scanner error instead of throwing: a deliberate
          // divergence (index.ts), pinned by pyYaml.test.ts.
          throw markedError(
            "while scanning a double-quoted scalar",
            startMark,
            "chr() arg not in range(0x110000)",
            r.getMark(),
          );
        }
        chunks.push(String.fromCodePoint(code));
        r.forward(codeLength);
      } else if (BREAKS.includes(ch)) {
        r.scanLineBreak();
        extend(chunks, scanFlowScalarBreaks(r, startMark));
      } else {
        throw markedError(
          "while scanning a double-quoted scalar",
          startMark,
          `found unknown escape character ${pyReprStr(ch)}`,
          r.getMark(),
        );
      }
    } else {
      return;
    }
  }
}

function scanFlowScalarSpaces(r: Reader, startMark: YamlMark, chunks: string[]): void {
  let length = 0;
  while (" \t".includes(r.peek(length))) length += 1;
  const whitespaces = r.prefix(length);
  r.forward(length);
  const ch = r.peek();
  if (ch === "\0") {
    throw markedError(
      "while scanning a quoted scalar",
      startMark,
      "found unexpected end of stream",
      r.getMark(),
    );
  }
  if (BREAKS.includes(ch)) {
    const lineBreak = r.scanLineBreak();
    const breaks = scanFlowScalarBreaks(r, startMark);
    if (lineBreak !== "\n") chunks.push(lineBreak);
    else if (breaks.length === 0) chunks.push(" ");
    extend(chunks, breaks);
  } else {
    chunks.push(whitespaces);
  }
}

function scanFlowScalarBreaks(r: Reader, startMark: YamlMark): string[] {
  const chunks: string[] = [];
  for (;;) {
    // Instead of checking indentation, we check for document separators.
    if (atDocumentSeparator(r)) {
      throw markedError(
        "while scanning a quoted scalar",
        startMark,
        "found unexpected document separator",
        r.getMark(),
      );
    }
    while (" \t".includes(r.peek())) r.forward();
    if (BREAKS.includes(r.peek())) chunks.push(r.scanLineBreak());
    else return chunks;
  }
}

// Plain scalars. In flow context they cannot contain `,` `?` `[` `]` `{` `}`; indentation is only
// checked in block context. Tabs end a plain scalar.

export function scanPlain(s: ScanState): ScalarToken {
  const r = s.reader;
  const chunks: string[] = [];
  const startMark = r.getMark();
  let endMark = startMark;
  const indent = s.indent + 1;
  const afterColon = s.flowLevel !== 0 ? `${NUL_BLANK_BREAK},[]{}` : NUL_BLANK_BREAK;
  let spaces: string[] | null = [];
  for (;;) {
    let length = 0;
    if (r.peek() === "#") break;
    for (;;) {
      const ch = r.peek(length);
      if (
        NUL_BLANK_BREAK.includes(ch) ||
        (ch === ":" && afterColon.includes(r.peek(length + 1))) ||
        (s.flowLevel !== 0 && ",?[]{}".includes(ch))
      ) {
        break;
      }
      length += 1;
    }
    if (length === 0) break;
    s.allowSimpleKey = false;
    extend(chunks, spaces);
    chunks.push(r.prefix(length));
    r.forward(length);
    endMark = r.getMark();
    spaces = scanPlainSpaces(s);
    if (
      spaces === null ||
      spaces.length === 0 ||
      r.peek() === "#" ||
      (s.flowLevel === 0 && r.column < indent)
    ) {
      break;
    }
  }
  return scalarToken(chunks.join(""), true, startMark, endMark, null);
}

/** The spaces and line breaks after a plain chunk, folded; `null` at a document separator. */
function scanPlainSpaces(s: ScanState): string[] | null {
  const r = s.reader;
  const chunks: string[] = [];
  let length = 0;
  while (r.peek(length) === " ") length += 1;
  const whitespaces = r.prefix(length);
  r.forward(length);
  const ch = r.peek();
  if (BREAKS.includes(ch)) {
    const lineBreak = r.scanLineBreak();
    s.allowSimpleKey = true;
    if (atDocumentSeparator(r)) return null;
    const breaks: string[] = [];
    while (` ${BREAKS}`.includes(r.peek())) {
      if (r.peek() === " ") {
        r.forward();
      } else {
        breaks.push(r.scanLineBreak());
        if (atDocumentSeparator(r)) return null;
      }
    }
    if (lineBreak !== "\n") chunks.push(lineBreak);
    else if (breaks.length === 0) chunks.push(" ");
    extend(chunks, breaks);
  } else if (whitespaces !== "") {
    chunks.push(whitespaces);
  }
  return chunks;
}
