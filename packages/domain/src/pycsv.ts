/**
 * CPython's `csv.reader` (excel dialect: `"` quotes, doubled quotes, `QUOTE_MINIMAL`, no escape char,
 * no initial-space skipping), a port of `Modules/_csv.c`'s state machine, with the `strict` flag, the
 * field size limit and `line_num`. Errors are returned, never thrown. Checked against Python 3.14 by
 * `pycsv.test.ts` (`budget-csv.jsonl`, written by `parity/python/vectors_budget.py`).
 */

export interface CsvOptions {
  /** One code point. */
  readonly delimiter: string;
  /** `strict=True`: a stray character after a closing quote and end of data inside quotes fail. */
  readonly strict?: boolean;
  /**
   * How the source is split into the lines the reader iterates: `"lf"` = `io.StringIO(text)` (at
   * `\n` only), `"universal"` = `io.StringIO(text, newline="")` (at `\r\n`, `\r` and `\n`, kept).
   */
  readonly lines?: "lf" | "universal";
}

export type CsvErrorReason =
  | "field_limit"
  | "newline_in_unquoted"
  | "quote_expected"
  | "unexpected_eof";

/** `lineNum` = the reader's `line_num` (lines consumed; on an error, the line that failed). */
export type CsvResult =
  | { ok: true; rows: string[][]; lineNum: number }
  | { ok: false; lineNum: number; reason: CsvErrorReason };

/** `csv.field_size_limit()` default, in code points. */
export const CSV_FIELD_LIMIT = 131072;

/** The text of the `csv.Error` CPython raises for `reason` (`delimiter` as given to the reader). */
export function csvErrorMessage(reason: CsvErrorReason, delimiter: string): string {
  switch (reason) {
    case "field_limit":
      return `field larger than field limit (${CSV_FIELD_LIMIT})`;
    case "newline_in_unquoted":
      return "new-line character seen in unquoted field - do you need to open the file with newline=''?";
    case "quote_expected":
      return `'${delimiter}' expected after '"'`;
    case "unexpected_eof":
      return "unexpected end of data";
  }
}

/** Reader states (`_csv.c` names); plain constants so Node's type stripping can run this file. */
const State = {
  StartRecord: 0,
  StartField: 1,
  InField: 2,
  InQuotedField: 3,
  QuoteInQuotedField: 4,
  EatCrnl: 5,
} as const;
type State = (typeof State)[keyof typeof State];

/** End of a source line (CPython's `EOL` sentinel). */
const EOL = null;

function splitLines(text: string, mode: "lf" | "universal"): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    } else if (c === 0x0d && mode === "universal") {
      const end = text.charCodeAt(i + 1) === 0x0a ? i + 2 : i + 1;
      out.push(text.slice(start, end));
      start = end;
      i = end - 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

class Reader {
  private state: State = State.StartRecord;
  private fields: string[] = [];
  private field: string[] = [];
  readonly rows: string[][] = [];
  lineNum = 0;

  private readonly delimiter: string;
  private readonly strict: boolean;

  constructor(delimiter: string, strict: boolean) {
    this.delimiter = delimiter;
    this.strict = strict;
  }

  private save(): void {
    this.fields.push(this.field.join(""));
    this.field = [];
  }

  private add(c: string): CsvErrorReason | null {
    // PARITY(Q11): CPython refuses the character that would exceed the limit (code points).
    if (this.field.length >= CSV_FIELD_LIMIT) return "field_limit";
    this.field.push(c);
    return null;
  }

  private endField(c: string | null): void {
    this.save();
    this.state = c === EOL ? State.StartRecord : State.EatCrnl;
  }

  /** `parse_process_char`. */
  private step(c: string | null): CsvErrorReason | null {
    const newline = c === "\n" || c === "\r";
    switch (this.state) {
      case State.StartRecord:
        if (c === EOL) return null; // an empty line: an empty record
        if (newline) {
          this.state = State.EatCrnl;
          return null;
        }
        this.state = State.StartField;
        return this.step(c);
      case State.StartField:
        if (newline || c === EOL) this.endField(c);
        else if (c === '"') this.state = State.InQuotedField;
        else if (c === this.delimiter) this.save();
        else {
          this.state = State.InField;
          return this.add(c);
        }
        return null;
      case State.InField:
        if (newline || c === EOL) this.endField(c);
        else if (c === this.delimiter) {
          this.save();
          this.state = State.StartField;
        } else return this.add(c);
        return null;
      case State.InQuotedField:
        if (c === EOL) return null;
        if (c === '"') this.state = State.QuoteInQuotedField;
        else return this.add(c);
        return null;
      case State.QuoteInQuotedField:
        if (c === '"') {
          this.state = State.InQuotedField;
          return this.add(c);
        }
        if (c === this.delimiter) {
          this.save();
          this.state = State.StartField;
        } else if (newline || c === EOL) this.endField(c);
        else if (!this.strict) {
          this.state = State.InField;
          return this.add(c);
        } else return "quote_expected";
        return null;
      case State.EatCrnl:
        if (newline) return null;
        if (c === EOL) {
          this.state = State.StartRecord;
          return null;
        }
        return "newline_in_unquoted";
    }
  }

  /** One source line; a finished record is appended to `rows`. */
  feed(line: string): CsvErrorReason | null {
    this.lineNum++;
    for (const c of line) {
      const error = this.step(c);
      if (error) return error;
    }
    const error = this.step(EOL);
    if (error) return error;
    if (this.state === State.StartRecord) {
      this.rows.push(this.fields);
      this.fields = [];
    }
    return null;
  }

  /** End of input inside a record: `unexpected end of data` (strict) or the partial record. */
  finish(): CsvErrorReason | null {
    if (this.field.length === 0 && this.state !== State.InQuotedField) return null;
    if (this.strict) return "unexpected_eof";
    this.save();
    this.rows.push(this.fields);
    this.fields = [];
    return null;
  }
}

function run(lines: readonly string[], opts: CsvOptions): CsvResult {
  const reader = new Reader(opts.delimiter, opts.strict ?? false);
  for (const line of lines) {
    const reason = reader.feed(line);
    if (reason) return { ok: false, lineNum: reader.lineNum, reason };
  }
  const reason = reader.finish();
  if (reason) return { ok: false, lineNum: reader.lineNum, reason };
  return { ok: true, rows: reader.rows, lineNum: reader.lineNum };
}

/** `list(csv.reader(io.StringIO(text[, newline=""]), delimiter=..., strict=...))`. */
export function readCsv(text: string, opts: CsvOptions): CsvResult {
  return run(splitLines(text, opts.lines ?? "lf"), opts);
}

/** `list(csv.reader(lines, ...))`: each item is one source line as given. */
export function readCsvLines(lines: readonly string[], opts: CsvOptions): CsvResult {
  return run(lines, opts);
}
