/**
 * Erste Bank Polska (formerly Santander Bank Polska) CSV export (Python `csv_import/erste.py`): UTF-8
 * with BOM, `,`-delimited, quoted, NO header row. An optional first summary row carries the export
 * date, the own account (apostrophe-guarded) in column 2, the currency in 4 and the balance in 6; then
 * `booking_date, value_date, title, counterparty_name, counterparty_account, amount, balance_after, ...`.
 */

import type { PyCodec } from "../../../codecs.js";
import { readCsv, readCsvLines } from "../../../pycsv.js";
import { pyLower, pySplitlines, pyStrip, pyStripChars, pyUpper } from "../../../text.js";
import { findAccountNumber, parsePlDate } from "../plFormats.js";
import type {
  AccountNumberOrigin,
  DatedAmount,
  ParsedStatement,
  RawTransaction,
} from "../types.js";
import { amountOrRefuse, readStatementText } from "./delimited.js";
import { refuse } from "./result.js";

/** @package */
export const ERSTE_ENCODINGS: readonly PyCodec[] = ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"];
/** @package */
export const ERSTE_SIGNATURE: readonly string[] = ["santander bank polska", "erste bank", "bzwbk"];
const CURRENCY_RE = /^[A-Za-z]{3}$/;

function looksLikeSummaryRow(cells: readonly string[]): boolean {
  return (
    cells.length >= 7 &&
    cells.some((c) => pyStrip(c).startsWith("'") && findAccountNumber(c) !== null)
  );
}

/** The first non-blank line (`str.splitlines`, `str.strip`), or undefined. */
function firstLine(text: string): string | undefined {
  return pySplitlines(text).find((l) => pyStrip(l) !== "");
}

/**
 * Python's `ErsteImporter.match_score`, exactly: signature hits, + 2 when the first non-blank line,
 * split at every `,`, looks like the summary row (exports carry no bank name).
 */
export function ersteScore(text: string): number {
  const low = pyLower(text);
  const score = ERSTE_SIGNATURE.filter((sig) => low.includes(pyLower(sig))).length;
  const line = firstLine(text);
  return line !== undefined && looksLikeSummaryRow(line.split(",")) ? score + 2 : score;
}

/**
 * FIX(Q4): Python split the first line at every `,`, so a quoted export without the bank's name was
 * never detected. Read as a csv record, that line shows the summary row. Detection uses this only
 * when Python's own scores pick no bank, so no file Python detected changes bank (or hashes).
 */
export function looksLikeQuotedErsteExport(text: string): boolean {
  const line = firstLine(text);
  if (line === undefined) return false;
  const parsed = readCsvLines([line], { delimiter: "," });
  return parsed.ok && looksLikeSummaryRow(parsed.rows[0] ?? []);
}

export function parseErste(bytes: Uint8Array): ParsedStatement {
  const text = readStatementText(bytes, ERSTE_ENCODINGS);
  const records = readCsv(text, { delimiter: "," });
  // PARITY(Q11): a csv.Error (e.g. a field over 131072 code points) refuses the whole file, as in Python.
  if (!records.ok) refuse({ ok: false, reason: "bad_csv", line: records.lineNum });
  // Blank rows are dropped before anything is counted; `record` keeps the 1-based csv record number.
  const rows = records.rows
    .map((cells, i) => ({ cells, record: i + 1 }))
    .filter(({ cells }) => cells.length > 0 && cells.some((c) => pyStrip(c)));

  let accountNumber: string | null = null;
  let origin: AccountNumberOrigin | null = null;
  let currency = "PLN";
  const balances: DatedAmount[] = [];
  let start = 0;
  const first = rows[0];
  if (first) {
    const c = first.cells;
    const own = c.length > 2 ? findAccountNumber(c[2] as string) : null;
    if (own && pyStrip(c[2] as string).startsWith("'")) {
      accountNumber = own;
      origin = "summary";
      if (c.length > 4 && CURRENCY_RE.test(pyStrip(c[4] as string)))
        currency = pyUpper(pyStrip(c[4] as string));
      const balance = c.length > 6 ? amountOrRefuse(c[6] as string, first.record) : null;
      const date = parsePlDate(c[0] as string);
      if (balance !== null && date !== null) balances.push({ date, amount: balance });
      start = 1;
    }
  }

  const transactions: RawTransaction[] = [];
  let skippedRows = 0;
  for (const { cells: row, record } of rows.slice(start)) {
    if (row.length < 6) {
      skippedRows++;
      continue;
    }
    const booking = parsePlDate(pyStripChars(pyStrip(row[0] as string), "'", "left"));
    const amount = amountOrRefuse(row[5] as string, record);
    if (booking === null || amount === null) {
      skippedRows++;
      continue;
    }
    const cell = (i: number) => (i < row.length ? pyStrip(row[i] as string) || null : null);
    transactions.push({
      bookingDate: booking,
      valueDate: parsePlDate(row[1] as string),
      amount,
      currency,
      counterpartyName: cell(3),
      counterpartyIban: cell(4),
      // PARITY(Q5): description and reference are both the title, so the memo holds it twice.
      description: cell(2),
      reference: cell(2),
      bankTransactionId: null,
      source: "csv",
      raw: { row },
    });
    if (row.length > 6) {
      const balance = amountOrRefuse(row[6] as string, record);
      if (balance !== null) balances.push({ date: booking, amount: balance });
    }
  }

  if (!accountNumber) {
    // PARITY(Q6): without a summary row the first account number in the file, usually a counterparty's.
    accountNumber = findAccountNumber(text);
    origin = accountNumber === null ? null : "scan";
  }
  return {
    bank: "erste",
    accountNumber,
    accountNumberOrigin: origin,
    accountName: null,
    currency,
    transactions,
    balances,
    closingBalances: [],
    skippedRows,
  };
}
