/**
 * PyYAML's `Reader` for a `str` input (`reader.py`): the printable-character check, the buffer of code
 * points with the NUL sentinel, and the index / line / column tracking of `forward`. Python indexes a
 * `str` by code point, so the buffer holds one code point per element (an astral character is one
 * element, a lone surrogate too).
 */

import { YamlFailure, type YamlMark } from "./errors.js";

/** `Reader.NON_PRINTABLE`: tab, LF, CR, printable ASCII, NEL, U+00A0-U+D7FF, U+E000-U+FFFD, astral. */
function isPrintable(cp: number): boolean {
  return (
    cp === 0x09 ||
    cp === 0x0a ||
    cp === 0x0d ||
    (cp >= 0x20 && cp <= 0x7e) ||
    cp === 0x85 ||
    (cp >= 0xa0 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** The NUL sentinel, a blank or a line break (PyYAML's `'\0 \t\r\n\x85\u2028\u2029'`). */
export const NUL_BLANK_BREAK = "\0 \t\r\n\x85\u2028\u2029";

/** What the scalar scanners read and change of the `Scanner`. */
export interface ScanState {
  readonly reader: Reader;
  readonly indent: number;
  readonly flowLevel: number;
  allowSimpleKey: boolean;
}

export class Reader {
  /** The input's code points followed by `"\0"`. */
  readonly buffer: readonly string[];
  /** Code points consumed (`Reader.index`, equal to `pointer` for a `str` input). */
  index = 0;
  line = 0;
  column = 0;

  constructor(text: string) {
    const chars = Array.from(text);
    // `check_printable`: the first refused code point, at its code point position.
    for (const [i, ch] of chars.entries()) {
      const cp = ch.codePointAt(0) ?? 0;
      if (!isPrintable(cp)) {
        throw new YamlFailure({ kind: "reader", position: i, character: cp });
      }
    }
    chars.push("\0");
    this.buffer = chars;
  }

  /** `peek(index)`: the code point `index` ahead. PyYAML never looks past the NUL sentinel. */
  peek(index = 0): string {
    const ch = this.buffer[this.index + index];
    if (ch === undefined) throw new Error(`pyYaml reader: peek past the end (${index})`);
    return ch;
  }

  /** `prefix(length)`: the next `length` code points (fewer at the end). */
  prefix(length = 1): string {
    if (length === 1) return this.buffer[this.index] ?? "";
    return this.buffer.slice(this.index, this.index + length).join("");
  }

  /** `forward(length)`: a line break (a CR only when no LF follows) starts a line; a BOM has no width. */
  forward(length = 1): void {
    for (let n = length; n > 0; n--) {
      const ch = this.peek();
      this.index += 1;
      if (
        ch === "\n" ||
        ch === "\x85" ||
        ch === "\u2028" ||
        ch === "\u2029" ||
        (ch === "\r" && this.buffer[this.index] !== "\n")
      ) {
        this.line += 1;
        this.column = 0;
      } else if (ch !== "\uFEFF") {
        this.column += 1;
      }
    }
  }

  getMark(): YamlMark {
    return { line: this.line, column: this.column, index: this.index };
  }

  /**
   * `Scanner.scan_line_break`: `\r\n`, `\r`, `\n` and NEL read as `"\n"`, LS / PS as themselves, else
   * nothing is consumed and the result is `""`.
   */
  scanLineBreak(): string {
    const ch = this.peek();
    if (ch === "\r" || ch === "\n" || ch === "\x85") {
      if (this.prefix(2) === "\r\n") this.forward(2);
      else this.forward();
      return "\n";
    }
    if (ch === "\u2028" || ch === "\u2029") {
      this.forward();
      return ch;
    }
    return "";
  }
}
