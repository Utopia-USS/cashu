/**
 * Polish statement formats (Python `csv_import/base.py`: `parse_pl_amount`, `parse_pl_date`,
 * `find_account_number`). Checked against Python by `plFormats.test.ts` (`budget-plformats.jsonl`).
 */

import type { IsoDate } from "../../dates.js";
import { Decimal, DecimalError } from "../../decimal.js";
import { PY_WS, pyStrip, unicodeDecimal } from "../../text.js";

const AMOUNT_JUNK = /[^\p{Nd},.\-+]/gu;

/**
 * `parse_pl_amount`: `"-1 234,56 PLN"` -> -1234.56, `"1.234,56"` -> 1234.56; null when empty or only a
 * sign. `"invalid"` where Python's `Decimal()` raises (`"1-2"`, `"1.234.567"`): PARITY(Q1) the caller
 * refuses the whole file, as Python's uncaught `InvalidOperation` did.
 * PARITY(Q2): without a comma the dot is the decimal point (`"1.234"` -> 1.234).
 */
export function parsePlAmount(value: string | null): Decimal | null | "invalid" {
  if (value === null) return null;
  let s = pyStrip(value);
  if (!s) return null;
  s = s.replace(AMOUNT_JUNK, "");
  if (!s || s === "-" || s === "+") return null;
  if (s.includes(",")) s = s.replaceAll(".", "").replaceAll(",", ".");
  try {
    return Decimal.parse(s);
  } catch (error) {
    if (error instanceof DecimalError) return "invalid";
    throw error;
  }
}

// datetime.strptime building blocks (CPython _strptime regexes; \d is any Unicode decimal digit).
const D = "(3[0-1]|[1-2]\\p{Nd}|0[1-9]|[1-9]| [1-9])";
const M = "(1[0-2]|0[1-9]|[1-9])";
const Y = "(\\p{Nd}\\p{Nd}\\p{Nd}\\p{Nd})";
/** `_DATE_FORMATS` in order: %Y-%m-%d, %d.%m.%Y, %d-%m-%Y, %Y/%m/%d, %d/%m/%Y. */
const DATE_FORMATS: readonly (readonly [RegExp, "ymd" | "dmy"])[] = [
  [new RegExp(`^${Y}-${M}-${D}`, "u"), "ymd"],
  [new RegExp(`^${D}\\.${M}\\.${Y}`, "u"), "dmy"],
  [new RegExp(`^${D}-${M}-${Y}`, "u"), "dmy"],
  [new RegExp(`^${Y}/${M}/${D}`, "u"), "ymd"],
  [new RegExp(`^${D}/${M}/${Y}`, "u"), "dmy"],
];

/** `int(text)` of a strptime group: Unicode decimal digits, a leading space allowed (`" 5"`). */
function groupInt(text: string): number {
  let n = 0;
  for (const ch of pyStrip(text)) n = n * 10 + unicodeDecimal(ch.codePointAt(0) as number);
  return n;
}

function realDate(year: number, month: number, day: number): IsoDate | null {
  if (year < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  if (day < 1 || day > days) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * `parse_pl_date`: the first of the five formats `strptime` accepts, else null. strptime matches its
 * regex at the start and refuses unconverted trailing text (no backtracking to make the whole string
 * fit), then checks the calendar.
 */
export function parsePlDate(value: string | null): IsoDate | null {
  if (!value) return null;
  const s = pyStrip(value);
  for (const [re, order] of DATE_FORMATS) {
    const m = re.exec(s);
    if (!m || m[0].length !== s.length) continue;
    const a = groupInt(m[1] as string);
    const month = groupInt(m[2] as string);
    const b = groupInt(m[3] as string);
    const iso = order === "ymd" ? realDate(a, month, b) : realDate(b, month, a);
    if (iso !== null) return iso;
  }
  return null;
}

const ACCOUNT_RE = new RegExp(`(?:PL)?[${PY_WS}]?(?:\\p{Nd}[${PY_WS}]?){26}`, "u");
const WS_RUN = new RegExp(`[${PY_WS}]+`, "gu");

/** `find_account_number`: the first Polish NRB / IBAN in the text (spaced or not), whitespace removed. */
export function findAccountNumber(text: string): string | null {
  const m = ACCOUNT_RE.exec(text);
  return m ? m[0].replace(WS_RUN, "") : null;
}
