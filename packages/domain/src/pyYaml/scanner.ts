/**
 * PyYAML's `Scanner` (`scanner.py`): the token queue, simple keys, indentation, flow levels and the
 * fetchers. The scalar scanners live in `scanScalars.ts`, the directive / anchor / tag scanners in
 * `scanTags.ts`; both work on the `ScanState` this class exposes.
 */

import { pyReprStr } from "../pyRepr.js";
import { markedError, type YamlMark } from "./errors.js";
import { NUL_BLANK_BREAK, type Reader, type ScanState } from "./reader.js";
import { scanBlockScalar, scanFlowScalar, scanPlain } from "./scanScalars.js";
import { scanAnchor, scanDirective, scanTag } from "./scanTags.js";
import type { SimpleTokenId, Token, TokenId } from "./tokens.js";

/** `SimpleKey`: a token that may turn out to be a key once its `:` is found. */
interface SimpleKey {
  readonly tokenNumber: number;
  readonly required: boolean;
  readonly index: number;
  readonly line: number;
  readonly column: number;
  readonly mark: YamlMark;
}

export class Scanner implements ScanState {
  readonly reader: Reader;
  /** The STREAM-END token was produced. */
  private done = false;
  /** Unclosed `[` and `{`; 0 = block context. */
  flowLevel = 0;
  /**
   * Produced tokens; the ones from `head` on are not yet taken by the parser (a head index instead of
   * `shift()`, which copies the array: the stream end can queue one BLOCK-END per open level).
   */
  private tokens: Token[] = [];
  private head = 0;
  private tokensTaken = 0;
  indent = -1;
  private readonly indents: number[] = [];
  /** A simple key (and in block context a block collection) may start here. */
  allowSimpleKey = true;
  /** One possible simple key per flow level, in insertion order like the Python dict. */
  private readonly possibleSimpleKeys = new Map<number, SimpleKey>();

  constructor(reader: Reader) {
    this.reader = reader;
    this.addSimple("<stream start>", reader.getMark(), reader.getMark());
  }

  // Public methods.

  /** `check_token(*choices)`: the next token is one of `choices` (any token when none given). */
  checkToken(...choices: readonly TokenId[]): boolean {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    const first = this.tokens[this.head];
    if (first === undefined) return false;
    return choices.length === 0 || choices.includes(first.id);
  }

  /** `peek_token()`. The parser never asks past STREAM-END. */
  peekToken(): Token {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    const first = this.tokens[this.head];
    if (first === undefined) throw new Error("pyYaml scanner: no token after the stream end");
    return first;
  }

  /** `get_token()`. */
  getToken(): Token {
    while (this.needMoreTokens()) this.fetchMoreTokens();
    const first = this.tokens[this.head];
    if (first === undefined) throw new Error("pyYaml scanner: no token after the stream end");
    this.head += 1;
    if (this.head === this.tokens.length) {
      this.tokens = [];
      this.head = 0;
    } else if (this.head > 4096 && this.head * 2 > this.tokens.length) {
      this.tokens = this.tokens.slice(this.head);
      this.head = 0;
    }
    this.tokensTaken += 1;
    return first;
  }

  // Private methods.

  private needMoreTokens(): boolean {
    if (this.done) return false;
    if (this.head === this.tokens.length) return true;
    // The current token may be a potential simple key, so we need to look further.
    this.stalePossibleSimpleKeys();
    return this.nextPossibleSimpleKey() === this.tokensTaken;
  }

  private fetchMoreTokens(): void {
    const r = this.reader;
    this.scanToNextToken();
    this.stalePossibleSimpleKeys();
    this.unwindIndent(r.column);
    const ch = r.peek();
    if (ch === "\0") this.fetchStreamEnd();
    else if (ch === "%" && r.column === 0) this.fetchDirective();
    else if (ch === "-" && this.checkDocumentIndicator("---")) {
      this.fetchDocumentIndicator("<document start>");
    } else if (ch === "." && this.checkDocumentIndicator("...")) {
      this.fetchDocumentIndicator("<document end>");
    } else if (ch === "[") this.fetchFlowCollectionStart("[");
    else if (ch === "{") this.fetchFlowCollectionStart("{");
    else if (ch === "]") this.fetchFlowCollectionEnd("]");
    else if (ch === "}") this.fetchFlowCollectionEnd("}");
    else if (ch === ",") this.fetchFlowEntry();
    else if (ch === "-" && NUL_BLANK_BREAK.includes(r.peek(1))) this.fetchBlockEntry();
    else if (ch === "?" && this.checkKeyOrValue()) this.fetchKey();
    else if (ch === ":" && this.checkKeyOrValue()) this.fetchValue();
    else if (ch === "*" || ch === "&") {
      // ALIAS / ANCHOR could be a simple key; no simple keys after them.
      this.savePossibleSimpleKey();
      this.allowSimpleKey = false;
      this.tokens.push(scanAnchor(r));
    } else if (ch === "!") {
      this.savePossibleSimpleKey();
      this.allowSimpleKey = false;
      this.tokens.push(scanTag(r));
    } else if ((ch === "|" || ch === ">") && this.flowLevel === 0) {
      // A simple key may follow a block scalar.
      this.allowSimpleKey = true;
      this.removePossibleSimpleKey();
      this.tokens.push(scanBlockScalar(this, ch));
    } else if (ch === "'" || ch === '"') {
      this.savePossibleSimpleKey();
      this.allowSimpleKey = false;
      this.tokens.push(scanFlowScalar(r, ch));
    } else if (this.checkPlain()) {
      // No simple keys after plain scalars, but `scanPlain` sets the flag again when the scalar
      // ends at the beginning of a line.
      this.savePossibleSimpleKey();
      this.allowSimpleKey = false;
      this.tokens.push(scanPlain(this));
    } else {
      throw markedError(
        "while scanning for the next token",
        null,
        `found character ${pyReprStr(ch)} that cannot start any token`,
        r.getMark(),
      );
    }
  }

  // Simple keys treatment.

  private nextPossibleSimpleKey(): number | null {
    let min: number | null = null;
    for (const key of this.possibleSimpleKeys.values()) {
      if (min === null || key.tokenNumber < min) min = key.tokenNumber;
    }
    return min;
  }

  /** Drops possible simple keys that left their line or are over 1024 code points long. */
  private stalePossibleSimpleKeys(): void {
    const r = this.reader;
    // Deleting the visited entry while iterating a Map is well-defined.
    for (const [level, key] of this.possibleSimpleKeys) {
      if (key.line !== r.line || r.index - key.index > 1024) {
        if (key.required) {
          throw markedError(
            "while scanning a simple key",
            key.mark,
            "could not find expected ':'",
            r.getMark(),
          );
        }
        this.possibleSimpleKeys.delete(level);
      }
    }
  }

  /** Called for ALIAS, ANCHOR, TAG, SCALAR(flow), `[` and `{`. */
  private savePossibleSimpleKey(): void {
    const r = this.reader;
    const required = this.flowLevel === 0 && this.indent === r.column;
    if (this.allowSimpleKey) {
      this.removePossibleSimpleKey();
      this.possibleSimpleKeys.set(this.flowLevel, {
        tokenNumber: this.tokensTaken + this.tokens.length - this.head,
        required,
        index: r.index,
        line: r.line,
        column: r.column,
        mark: r.getMark(),
      });
    }
  }

  private removePossibleSimpleKey(): void {
    const key = this.possibleSimpleKeys.get(this.flowLevel);
    if (key === undefined) return;
    if (key.required) {
      throw markedError(
        "while scanning a simple key",
        key.mark,
        "could not find expected ':'",
        this.reader.getMark(),
      );
    }
    this.possibleSimpleKeys.delete(this.flowLevel);
  }

  // Indentation functions.

  /** In block context, BLOCK-END for every indentation level above `column`. */
  private unwindIndent(column: number): void {
    if (this.flowLevel !== 0) return;
    while (this.indent > column) {
      const mark = this.reader.getMark();
      const previous = this.indents.pop();
      if (previous === undefined) throw new Error("pyYaml scanner: indentation stack underflow");
      this.indent = previous;
      this.addSimple("<block end>", mark, mark);
    }
  }

  private addIndent(column: number): boolean {
    if (this.indent < column) {
      this.indents.push(this.indent);
      this.indent = column;
      return true;
    }
    return false;
  }

  // Fetchers.

  private addSimple(id: SimpleTokenId, startMark: YamlMark, endMark: YamlMark): void {
    this.tokens.push({ id, startMark, endMark });
  }

  /** Adds a one-character token (`[ { ] } , - ? :`), moving past it. */
  private addIndicator(id: SimpleTokenId): void {
    const startMark = this.reader.getMark();
    this.reader.forward();
    this.addSimple(id, startMark, this.reader.getMark());
  }

  private fetchStreamEnd(): void {
    this.unwindIndent(-1);
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    this.possibleSimpleKeys.clear();
    const mark = this.reader.getMark();
    this.addSimple("<stream end>", mark, mark);
    this.done = true;
  }

  private fetchDirective(): void {
    this.unwindIndent(-1);
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    this.tokens.push(scanDirective(this.reader));
  }

  private fetchDocumentIndicator(id: "<document start>" | "<document end>"): void {
    this.unwindIndent(-1);
    // There could not be a block collection after '---'.
    this.removePossibleSimpleKey();
    this.allowSimpleKey = false;
    const startMark = this.reader.getMark();
    this.reader.forward(3);
    this.addSimple(id, startMark, this.reader.getMark());
  }

  private fetchFlowCollectionStart(id: "[" | "{"): void {
    this.savePossibleSimpleKey();
    this.flowLevel += 1;
    this.allowSimpleKey = true;
    this.addIndicator(id);
  }

  private fetchFlowCollectionEnd(id: "]" | "}"): void {
    this.removePossibleSimpleKey();
    this.flowLevel -= 1;
    this.allowSimpleKey = false;
    this.addIndicator(id);
  }

  private fetchFlowEntry(): void {
    this.allowSimpleKey = true;
    this.removePossibleSimpleKey();
    this.addIndicator(",");
  }

  private fetchBlockEntry(): void {
    const r = this.reader;
    if (this.flowLevel === 0) {
      if (!this.allowSimpleKey) {
        throw markedError(null, null, "sequence entries are not allowed here", r.getMark());
      }
      if (this.addIndent(r.column)) {
        const mark = r.getMark();
        this.addSimple("<block sequence start>", mark, mark);
      }
    }
    // A block entry in the flow context is left for the parser to report.
    this.allowSimpleKey = true;
    this.removePossibleSimpleKey();
    this.addIndicator("-");
  }

  private fetchKey(): void {
    const r = this.reader;
    if (this.flowLevel === 0) {
      if (!this.allowSimpleKey) {
        throw markedError(null, null, "mapping keys are not allowed here", r.getMark());
      }
      if (this.addIndent(r.column)) {
        const mark = r.getMark();
        this.addSimple("<block mapping start>", mark, mark);
      }
    }
    this.allowSimpleKey = this.flowLevel === 0;
    this.removePossibleSimpleKey();
    this.addIndicator("?");
  }

  private fetchValue(): void {
    const r = this.reader;
    const key = this.possibleSimpleKeys.get(this.flowLevel);
    if (key !== undefined) {
      // The saved simple key is a key: insert KEY (and BLOCK-MAPPING-START) before it.
      this.possibleSimpleKeys.delete(this.flowLevel);
      const at = this.head + key.tokenNumber - this.tokensTaken;
      this.tokens.splice(at, 0, { id: "?", startMark: key.mark, endMark: key.mark });
      if (this.flowLevel === 0 && this.addIndent(key.column)) {
        this.tokens.splice(at, 0, {
          id: "<block mapping start>",
          startMark: key.mark,
          endMark: key.mark,
        });
      }
      // There cannot be two simple keys one after another.
      this.allowSimpleKey = false;
    } else {
      // A part of a complex key.
      if (this.flowLevel === 0) {
        if (!this.allowSimpleKey) {
          throw markedError(null, null, "mapping values are not allowed here", r.getMark());
        }
        // A value starting a block mapping is reported later by the parser.
        if (this.addIndent(r.column)) {
          const mark = r.getMark();
          this.addSimple("<block mapping start>", mark, mark);
        }
      }
      this.allowSimpleKey = this.flowLevel === 0;
      this.removePossibleSimpleKey();
    }
    this.addIndicator(":");
  }

  // Checkers.

  /** DOCUMENT-START / DOCUMENT-END: `^---` or `^...` followed by a blank, a break or the end. */
  private checkDocumentIndicator(marker: string): boolean {
    const r = this.reader;
    return r.column === 0 && r.prefix(3) === marker && NUL_BLANK_BREAK.includes(r.peek(3));
  }

  /** KEY / VALUE: any `?` / `:` in flow context, followed by a blank or a break in block context. */
  private checkKeyOrValue(): boolean {
    return this.flowLevel !== 0 || NUL_BLANK_BREAK.includes(this.reader.peek(1));
  }

  /**
   * A plain scalar starts with any non-space character except the indicators; `-`, `?` and `:`
   * followed by a non-space character also start one (`?` and `:` only in block context).
   */
  private checkPlain(): boolean {
    const r = this.reader;
    const ch = r.peek();
    return (
      !"\0 \t\r\n\x85\u2028\u2029-?:,[]{}#&*!|>'\"%@`".includes(ch) ||
      (!NUL_BLANK_BREAK.includes(r.peek(1)) &&
        (ch === "-" || (this.flowLevel === 0 && (ch === "?" || ch === ":"))))
    );
  }

  // Scanners.

  /**
   * Skips spaces, line breaks and comments (a line break in block context allows a simple key) and
   * a BOM at the very start of the stream.
   */
  private scanToNextToken(): void {
    const r = this.reader;
    if (r.index === 0 && r.peek() === "\uFEFF") r.forward();
    for (;;) {
      while (r.peek() === " ") r.forward();
      if (r.peek() === "#") {
        while (!"\0\r\n\x85\u2028\u2029".includes(r.peek())) r.forward();
      }
      if (r.scanLineBreak() === "") return;
      if (this.flowLevel === 0) this.allowSimpleKey = true;
    }
  }
}
