// Python-compatible text primitives for the bank CSV connectors (mbank-csv, erste-csv, pekao-csv).
//
// These connectors are ports of cashU's former built-in Python parsers; a re-import must hash every
// row exactly as before, so the low-level behaviour is Python's, not JavaScript's: decoding with a
// fallback list of encodings (cp1250 refuses its 5 undefined bytes), universal newlines,
// `str.strip()` / `str.splitlines()` whitespace, the `csv` module's reader (excel dialect, not
// strict), `datetime.strptime` dates and `Decimal` amounts. The file is identical in the three
// connector directories (each connector must be self-contained); a test keeps the copies equal.
// Error messages never contain a value from the file.

export class BadFile extends Error {}

// --- whitespace, strip, splitlines -------------------------------------------------------------

/** Characters for which Python's `str.isspace()` is true (also what `re`'s `\s` matches). */
const PY_SPACE =
  "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "gu");
const SPACE_RUN_RE = new RegExp(`[${PY_SPACE}]+`, "gu");

/** `str.strip()`: Python's whitespace set (JavaScript's `trim()` differs: BOM, \x1c-\x1f, \x85). */
export function pyStrip(value: string): string {
  return value.replace(STRIP_RE, "");
}

/** `str.strip(chars)` / `lstrip(chars)` / `rstrip(chars)` with an explicit character set. */
export function pyStripChars(value: string, chars: string, left = true, right = true): string {
  let start = 0;
  let end = value.length;
  if (left) while (start < end && chars.includes(value[start])) start++;
  if (right) while (end > start && chars.includes(value[end - 1])) end--;
  return value.slice(start, end);
}

/** `str.splitlines()`: Python's line boundaries, no trailing empty line. */
export function pySplitlines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(/\r\n|[\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029]/u);
  const last = text[text.length - 1];
  if ("\n\r\x0b\x0c\x1c\x1d\x1e\x85\u2028\u2029".includes(last)) parts.pop();
  return parts;
}

/** Remove every run of Python whitespace (`re.sub(r"\s+", "", s)`). */
export function removeSpaces(value: string): string {
  return value.replace(SPACE_RUN_RE, "");
}

// --- decoding ------------------------------------------------------------------------------------

/** Bytes cp1250 leaves undefined: Python refuses them, the WHATWG decoder maps them to C1 controls. */
const CP1250_UNDEFINED = new Set([0x81, 0x83, 0x88, 0x90, 0x98]);

function decodeAs(bytes: Uint8Array, encoding: string): string | null {
  try {
    switch (encoding) {
      case "utf-8-sig": // strict UTF-8, a leading BOM dropped
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      case "utf-8": // strict UTF-8, a BOM kept as U+FEFF
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      case "cp1250":
        for (const b of bytes) if (CP1250_UNDEFINED.has(b)) return null;
        return new TextDecoder("windows-1250", { ignoreBOM: true }).decode(bytes);
      case "iso-8859-2":
        return new TextDecoder("iso-8859-2", { ignoreBOM: true }).decode(bytes);
    }
  } catch {
    return null;
  }
  throw new Error("unknown encoding");
}

/** `Path.read_text(encoding=...)` tried in order: the first encoding that decodes wins; newlines
 * translated as Python's universal newlines do (\r\n and \r become \n). */
export function readText(bytes: Uint8Array, encodings: readonly string[]): string {
  for (const encoding of encodings) {
    const text = decodeAs(bytes, encoding);
    if (text !== null) return text.replace(/\r\n?/g, "\n");
  }
  throw new BadFile("the file cannot be decoded as text");
}

// --- csv.reader ---------------------------------------------------------------------------------

const START_RECORD = 0;
const START_FIELD = 1;
const IN_FIELD = 2;
const IN_QUOTED_FIELD = 3;
const QUOTE_IN_QUOTED_FIELD = 4;
const EAT_CRNL = 5;

/** `list(csv.reader(io.StringIO(text), delimiter=d))`: the excel dialect (`"` quotes, doubled
 * quotes, not strict), a port of CPython's reader state machine. A blank line is an empty row. */
export function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let state = START_RECORD;

  const save = () => {
    fields.push(field);
    field = "";
  };
  const step = (c: string | null) => { // null = end of line (EOL)
    const newline = c === "\n" || c === "\r";
    switch (state) {
      case START_RECORD:
        if (c === null) return;
        if (newline) {
          state = EAT_CRNL;
          return;
        }
        state = START_FIELD;
      // falls through
      case START_FIELD:
        if (newline || c === null) {
          save();
          state = c === null ? START_RECORD : EAT_CRNL;
        } else if (c === '"') state = IN_QUOTED_FIELD;
        else if (c === delimiter) save();
        else {
          field += c;
          state = IN_FIELD;
        }
        return;
      case IN_FIELD:
        if (newline || c === null) {
          save();
          state = c === null ? START_RECORD : EAT_CRNL;
        } else if (c === delimiter) {
          save();
          state = START_FIELD;
        } else field += c;
        return;
      case IN_QUOTED_FIELD:
        if (c === null) return;
        if (c === '"') state = QUOTE_IN_QUOTED_FIELD;
        else field += c;
        return;
      case QUOTE_IN_QUOTED_FIELD:
        if (c === '"') {
          field += c;
          state = IN_QUOTED_FIELD;
        } else if (c === delimiter) {
          save();
          state = START_FIELD;
        } else if (newline || c === null) {
          save();
          state = c === null ? START_RECORD : EAT_CRNL;
        } else {
          field += c;
          state = IN_FIELD;
        }
        return;
      case EAT_CRNL:
        if (newline) return;
        if (c === null) {
          state = START_RECORD;
          return;
        }
        throw new BadFile("a new-line character inside an unquoted field");
    }
  };

  // io.StringIO yields lines ending in "\n" (the last one may lack it).
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    for (const c of text.slice(start, end)) step(c);
    step(null);
    start = end;
    if (state === START_RECORD) {
      rows.push(fields);
      fields = [];
    }
  }
  if (state !== START_RECORD && (field.length !== 0 || state === IN_QUOTED_FIELD)) {
    save();
    rows.push(fields);
  }
  return rows;
}

// --- digits, amounts, dates ---------------------------------------------------------------------

const ND = /\p{Nd}/u;

/** The value of a Unicode decimal digit (Python's `\d`, `int()` and `Decimal` accept them all).
 * Unicode encodes decimal digits in complete, contiguous runs 0..9, so the offset within the
 * contiguous block of digits, modulo 10, is the value. */
function digitValue(ch: string): number {
  const cp = ch.codePointAt(0)!;
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let start = cp;
  while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--;
  return (cp - start) % 10;
}

function asciiDigits(value: string): string {
  let out = "";
  for (const ch of value) out += ND.test(ch) ? String(digitValue(ch)) : ch;
  return out;
}

const AMOUNT_JUNK = /[^\p{Nd},.\-+]/gu;
const DECIMAL_RE = /^([+-]?)(?:(\p{Nd}+)(?:\.(\p{Nd}*))?|\.(\p{Nd}+))$/u;

/** `parse_pl_amount`: '-1 234,56 PLN' / '1.234,56' / '123,45' -> an exact decimal string with "."
 * ("-1234.56"), equal in value to Python's `Decimal`; null when empty. A string `Decimal` refuses
 * ("1.2.3") is a BadFile, as the Python parser failed on it. */
export function parsePlAmount(value: string | null): string | null {
  if (value === null) return null;
  let s = pyStrip(value);
  if (!s) return null;
  s = s.replace(AMOUNT_JUNK, "");
  if (!s || s === "-" || s === "+") return null;
  if (s.includes(",")) s = s.replaceAll(".", "").replaceAll(",", ".");
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new BadFile("an amount is not a number");
  const [, sign, whole, fraction, onlyFraction] = m;
  const intPart = whole !== undefined ? asciiDigits(whole) : "0";
  const fracPart = asciiDigits(whole !== undefined ? fraction ?? "" : onlyFraction);
  return `${sign === "-" ? "-" : ""}${intPart}${fracPart ? "." + fracPart : ""}`;
}

// datetime.strptime building blocks (Python's _strptime regexes; \d is any Unicode digit).
const D = "(3[0-1]|[1-2]\\p{Nd}|0[1-9]|[1-9]| [1-9])";
const M = "(1[0-2]|0[1-9]|[1-9])";
const Y = "(\\p{Nd}\\p{Nd}\\p{Nd}\\p{Nd})";
// _DATE_FORMATS in order: %Y-%m-%d, %d.%m.%Y, %d-%m-%Y, %Y/%m/%d, %d/%m/%Y
const DATE_FORMATS: [RegExp, "ymd" | "dmy"][] = [
  [new RegExp(`^${Y}-${M}-${D}`, "u"), "ymd"],
  [new RegExp(`^${D}\\.${M}\\.${Y}`, "u"), "dmy"],
  [new RegExp(`^${D}-${M}-${Y}`, "u"), "dmy"],
  [new RegExp(`^${Y}/${M}/${D}`, "u"), "ymd"],
  [new RegExp(`^${D}/${M}/${Y}`, "u"), "dmy"],
];

function realDate(year: number, month: number, day: number): string | null {
  if (year < 1) return null; // datetime: year 1..9999
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day < 1 || day > days) return null;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `parse_pl_date`: the first of the five formats that `strptime` accepts -> "YYYY-MM-DD", or null.
 * strptime matches its regex at the start and refuses unconverted trailing text (no backtracking to
 * make the whole string match), then checks the calendar. */
export function parsePlDate(value: string | null): string | null {
  if (!value) return null;
  const s = pyStrip(value);
  for (const [re, order] of DATE_FORMATS) {
    const m = re.exec(s);
    if (!m || m[0].length !== s.length) continue;
    const num = (x: string) => Number(asciiDigits(pyStrip(x)));
    const [a, month, b] = [m[1], m[2], m[3]];
    const [year, day] = order === "ymd" ? [num(a), num(b)] : [num(b), num(a)];
    const iso = realDate(year, num(month), day);
    if (iso !== null) return iso;
  }
  return null;
}

// --- account numbers ----------------------------------------------------------------------------

const ACCOUNT_RE = new RegExp(`(?:PL)?[${PY_SPACE}]?(?:\\p{Nd}[${PY_SPACE}]?){26}`, "u");

/** `find_account_number`: the first Polish NRB / IBAN (spaced or not) in the text, whitespace
 * removed (a "PL" prefix kept), or null. */
export function findAccountNumber(text: string): string | null {
  const m = ACCOUNT_RE.exec(text);
  return m ? removeSpaces(m[0]) : null;
}

// --- the cashu-budget-import document -----------------------------------------------------------

/** An account number as the budget import format takes it (letters and digits, 8 to 34 of them),
 * or null: an empty or unusable number is left out (the Python import ignored it the same way when
 * empty). */
export function accountNumber(value: string | null): string | null {
  if (value === null) return null;
  const canon = value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return canon.length >= 8 && canon.length <= 34 ? canon : null;
}

/** The format's text limit (in characters, as Python counts them). */
export function limitText(value: string | null, max: number): string | null {
  if (value === null) return null;
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join("");
}

export interface DocTransaction {
  booking_date: string;
  value_date: string | null;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  counterparty_iban: string | null;
  description: string | null;
  reference: string | null;
  balance_after: string | null;
}

export interface Statement {
  institution: string; // existing institution id: mbank | erste | pekao
  source: string;
  accountNumber: string | null;
  currency: string;
  transactions: DocTransaction[];
  balances: { date: string; amount: string }[];
}

/** The statement as a `cashu-budget-import` v1 document (docs/budget-import-format.md). The rows
 * keep the file's order (the import's end-of-day balance logic reads it); no transaction_id: the
 * exports carry no stable id, and the Python parsers never set one. */
export function toDocument(stmt: Statement) {
  const iban = accountNumber(stmt.accountNumber);
  const account: Record<string, string> = { currency: stmt.currency, institution: stmt.institution };
  if (iban !== null) account.iban = iban;
  const document: Record<string, unknown> = {
    format: "cashu-budget-import",
    format_version: 1,
    source: stmt.source,
    account,
    transactions: stmt.transactions.map((t) => ({
      ...t,
      counterparty_name: limitText(t.counterparty_name, 500),
      counterparty_iban: accountNumber(t.counterparty_iban),
      description: limitText(t.description, 500),
      reference: limitText(t.reference, 200),
    })),
  };
  if (stmt.balances.length) document.balances = stmt.balances;
  return document;
}
