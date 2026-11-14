/**
 * PyYAML's directive, anchor / alias and tag scanners (`scanner.py`), with tag handles, tag URIs and
 * their `%xx` escapes (decoded as strict UTF-8, CPython's error text on failure).
 */

import { decodeStrict, utf8ErrorReason } from "../codecs.js";
import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import type { Reader } from "./reader.js";
import type { DirectiveValue, Token } from "./tokens.js";

const NUL_OR_BREAK = "\0\r\n\x85\u2028\u2029";
const NUL_SPACE_BREAK = "\0 \r\n\x85\u2028\u2029";
const HEX = "0123456789ABCDEFabcdef";

/** `'0' <= ch <= '9' or 'A' <= ch <= 'Z' or 'a' <= ch <= 'z' or ch in '-_'`. */
function isWordChar(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "a" && ch <= "z") ||
    ch === "-" ||
    ch === "_"
  );
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** The ASCII characters a tag URI may hold besides letters and digits (`%` starts an escape). */
const URI_CHARS = "-;/?:@&=+$,_.!~*'()[]%";

// Directives.

export function scanDirective(r: Reader): Token {
  const startMark = r.getMark();
  r.forward();
  const name = scanDirectiveName(r, startMark);
  let value: DirectiveValue = null;
  let endMark: YamlMark;
  if (name === "YAML") {
    value = scanYamlDirectiveValue(r, startMark);
    endMark = r.getMark();
  } else if (name === "TAG") {
    value = scanTagDirectiveValue(r, startMark);
    endMark = r.getMark();
  } else {
    endMark = r.getMark();
    while (!NUL_OR_BREAK.includes(r.peek())) r.forward();
  }
  scanDirectiveIgnoredLine(r, startMark);
  return { id: "<directive>", name, value, startMark, endMark };
}

function directiveError(r: Reader, startMark: YamlMark, problem: string) {
  return markedError("while scanning a directive", startMark, problem, r.getMark());
}

function scanDirectiveName(r: Reader, startMark: YamlMark): string {
  let length = 0;
  let ch = r.peek(length);
  while (isWordChar(ch)) {
    length += 1;
    ch = r.peek(length);
  }
  if (length === 0) {
    throw directiveError(
      r,
      startMark,
      `expected alphabetic or numeric character, but found ${pyReprStr(ch)}`,
    );
  }
  const value = r.prefix(length);
  r.forward(length);
  ch = r.peek();
  if (!NUL_SPACE_BREAK.includes(ch)) {
    throw directiveError(
      r,
      startMark,
      `expected alphabetic or numeric character, but found ${pyReprStr(ch)}`,
    );
  }
  return value;
}

function scanYamlDirectiveValue(r: Reader, startMark: YamlMark): DirectiveValue {
  while (r.peek() === " ") r.forward();
  const major = scanYamlDirectiveNumber(r, startMark);
  if (r.peek() !== ".") {
    throw directiveError(r, startMark, `expected a digit or '.', but found ${pyReprStr(r.peek())}`);
  }
  r.forward();
  const minor = scanYamlDirectiveNumber(r, startMark);
  if (!NUL_SPACE_BREAK.includes(r.peek())) {
    throw directiveError(r, startMark, `expected a digit or ' ', but found ${pyReprStr(r.peek())}`);
  }
  return { kind: "yaml", major, minor };
}

function scanYamlDirectiveNumber(r: Reader, startMark: YamlMark): number {
  const ch = r.peek();
  if (!isDigit(ch)) {
    throw directiveError(r, startMark, `expected a digit, but found ${pyReprStr(ch)}`);
  }
  let length = 0;
  while (isDigit(r.peek(length))) length += 1;
  const value = Number(r.prefix(length));
  r.forward(length);
  return value;
}

function scanTagDirectiveValue(r: Reader, startMark: YamlMark): DirectiveValue {
  while (r.peek() === " ") r.forward();
  const handle = scanTagHandle(r, "directive", startMark);
  if (r.peek() !== " ") {
    throw directiveError(r, startMark, `expected ' ', but found ${pyReprStr(r.peek())}`);
  }
  while (r.peek() === " ") r.forward();
  const prefix = scanTagUri(r, "directive", startMark);
  if (!NUL_SPACE_BREAK.includes(r.peek())) {
    throw directiveError(r, startMark, `expected ' ', but found ${pyReprStr(r.peek())}`);
  }
  return { kind: "tag", handle, prefix };
}

function scanDirectiveIgnoredLine(r: Reader, startMark: YamlMark): void {
  while (r.peek() === " ") r.forward();
  if (r.peek() === "#") {
    while (!NUL_OR_BREAK.includes(r.peek())) r.forward();
  }
  const ch = r.peek();
  if (!NUL_OR_BREAK.includes(ch)) {
    throw directiveError(
      r,
      startMark,
      `expected a comment or a line break, but found ${pyReprStr(ch)}`,
    );
  }
  r.scanLineBreak();
}

// Anchors and aliases: names restricted to ASCII letters, digits, `-` and `_`.

export function scanAnchor(r: Reader): Token {
  const startMark = r.getMark();
  const id = r.peek() === "*" ? "<alias>" : "<anchor>";
  const name = id === "<alias>" ? "alias" : "anchor";
  r.forward();
  let length = 0;
  let ch = r.peek(length);
  while (isWordChar(ch)) {
    length += 1;
    ch = r.peek(length);
  }
  const fail = () =>
    markedError(
      `while scanning an ${name}`,
      startMark,
      `expected alphabetic or numeric character, but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  if (length === 0) throw fail();
  const value = r.prefix(length);
  r.forward(length);
  ch = r.peek();
  if (!"\0 \t\r\n\x85\u2028\u2029?:,]}%@`".includes(ch)) throw fail();
  return { id, value, startMark, endMark: r.getMark() };
}

// Tags.

export function scanTag(r: Reader): Token {
  const startMark = r.getMark();
  let ch = r.peek(1);
  let handle: string | null;
  let suffix: string;
  if (ch === "<") {
    handle = null;
    r.forward(2);
    suffix = scanTagUri(r, "tag", startMark);
    if (r.peek() !== ">") {
      throw markedError(
        "while parsing a tag",
        startMark,
        `expected '>', but found ${pyReprStr(r.peek())}`,
        r.getMark(),
      );
    }
    r.forward();
  } else if ("\0 \t\r\n\x85\u2028\u2029".includes(ch)) {
    handle = null;
    suffix = "!";
    r.forward();
  } else {
    let length = 1;
    let useHandle = false;
    // No tab in this set (as in PyYAML): a tab does not end the search for a second `!`.
    while (!NUL_SPACE_BREAK.includes(ch)) {
      if (ch === "!") {
        useHandle = true;
        break;
      }
      length += 1;
      ch = r.peek(length);
    }
    if (useHandle) {
      handle = scanTagHandle(r, "tag", startMark);
    } else {
      handle = "!";
      r.forward();
    }
    suffix = scanTagUri(r, "tag", startMark);
  }
  ch = r.peek();
  if (!NUL_SPACE_BREAK.includes(ch)) {
    throw markedError(
      "while scanning a tag",
      startMark,
      `expected ' ', but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  }
  return { id: "<tag>", value: [handle, suffix], startMark, endMark: r.getMark() };
}

/** `!`, `!!` or `!word!` (`_` allowed although the specification does not). */
function scanTagHandle(r: Reader, name: string, startMark: YamlMark): string {
  let ch = r.peek();
  if (ch !== "!") {
    throw markedError(
      `while scanning a ${name}`,
      startMark,
      `expected '!', but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  }
  let length = 1;
  ch = r.peek(length);
  if (ch !== " ") {
    while (isWordChar(ch)) {
      length += 1;
      ch = r.peek(length);
    }
    if (ch !== "!") {
      r.forward(length);
      throw markedError(
        `while scanning a ${name}`,
        startMark,
        `expected '!', but found ${pyReprStr(ch)}`,
        r.getMark(),
      );
    }
    length += 1;
  }
  const value = r.prefix(length);
  r.forward(length);
  return value;
}

/** The URI part of a tag; well-formedness is not checked. */
function scanTagUri(r: Reader, name: string, startMark: YamlMark): string {
  const chunks: string[] = [];
  let length = 0;
  let ch = r.peek(length);
  while (isWordChar(ch) || URI_CHARS.includes(ch)) {
    if (ch === "%") {
      chunks.push(r.prefix(length));
      r.forward(length);
      length = 0;
      chunks.push(scanUriEscapes(r, name, startMark));
    } else {
      length += 1;
    }
    ch = r.peek(length);
  }
  if (length > 0) {
    chunks.push(r.prefix(length));
    r.forward(length);
  }
  if (chunks.length === 0) {
    throw markedError(
      `while parsing a ${name}`,
      startMark,
      `expected URI, but found ${pyReprStr(ch)}`,
      r.getMark(),
    );
  }
  return chunks.join("");
}

function scanUriEscapes(r: Reader, name: string, startMark: YamlMark): string {
  const codes: number[] = [];
  const mark = r.getMark();
  while (r.peek() === "%") {
    r.forward();
    for (let k = 0; k < 2; k++) {
      if (!HEX.includes(r.peek(k))) {
        throw markedError(
          `while scanning a ${name}`,
          startMark,
          `expected URI escape sequence of 2 hexadecimal numbers, but found ${pyReprStr(r.peek(k))}`,
          r.getMark(),
        );
      }
    }
    codes.push(Number.parseInt(r.prefix(2), 16));
    r.forward(2);
  }
  const bytes = Uint8Array.from(codes);
  const decoded = decodeStrict(bytes, "utf-8");
  if (decoded.ok) return decoded.text;
  throw markedError(
    `while scanning a ${name}`,
    startMark,
    utf8DecodeErrorText(bytes, decoded.start),
    mark,
  );
}

/**
 * `str(UnicodeDecodeError)` of `bytes.decode('utf-8')` failing at `start`: the error covers the
 * maximal valid prefix of the bad sequence (to the end of the data when it is cut short).
 */
function utf8DecodeErrorText(bytes: Uint8Array, start: number): string {
  const reason = utf8ErrorReason(bytes, start);
  let length = 1;
  if (reason !== "invalid start byte") {
    // The longest prefix that is only cut short (a valid lead byte and continuation bytes).
    while (
      start + length < bytes.length &&
      utf8ErrorReason(bytes.subarray(start, start + length + 1), 0) === "unexpected end of data"
    ) {
      length += 1;
    }
  }
  if (length === 1) {
    const byte = (bytes[start] ?? 0).toString(16).padStart(2, "0");
    return `'utf-8' codec can't decode byte 0x${byte} in position ${start}: ${reason}`;
  }
  return `'utf-8' codec can't decode bytes in position ${start}-${start + length - 1}: ${reason}`;
}
