// Erste Bank Polska (formerly Santander Bank Polska) CSV export: a port of cashU's former built-in
// parser (modules/budget/ingestion/csv_import/erste.py).
//
// Format: UTF-8 (BOM), comma-delimited, quoted fields, comma decimal, NO header row. The first row
// is an account summary carrying the own account number (apostrophe-guarded, column 3), the
// currency (column 5) and the current balance (column 7) on the export date (column 1, ISO); the
// rest are transactions in this fixed column order:
//
//   booking_date, value_date, title, counterparty_name, counterparty_account,
//   amount, balance_after, type_code[, trailing]
//
// Dates are DD-MM-YYYY. Legacy Santander (and older BZ WBK) exports share this shape, also in
// Windows-1250, and land in the same `erste` account (the account numbers did not change).

import {
  BadFile,
  csvRows,
  type DocTransaction,
  findAccountNumber,
  parsePlAmount,
  parsePlDate,
  pySplitlines,
  pyStrip,
  pyStripChars,
  readText,
  type Statement,
} from "./pycompat.ts";

const ENCODINGS = ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"];
const DEFAULT_CURRENCY = "PLN";
const SIGNATURE = ["santander bank polska", "erste bank", "bzwbk"];

function cellAt(row: string[], i: number): string | null {
  return i < row.length ? pyStrip(row[i]) || null : null;
}

export function parse(bytes: Uint8Array): Statement {
  const text = readText(bytes, ENCODINGS);
  const rows = csvRows(text, ",").filter((r) => r.length && r.some((c) => pyStrip(c)));

  let accountNumber: string | null = null;
  let currency = DEFAULT_CURRENCY;
  let summary: { date: string; amount: string } | null = null;
  let start = 0;

  // Optional leading summary row: col2 = own account, col4 = currency, col6 = current balance,
  // col0 = ISO export date.
  if (rows.length) {
    const first = rows[0];
    const own = first.length > 2 ? findAccountNumber(first[2]) : null;
    if (own && pyStrip(first[2]).startsWith("'")) {
      accountNumber = own;
      if (first.length > 4 && /^[A-Za-z]{3}$/.test(pyStrip(first[4]))) {
        currency = pyStrip(first[4]).toUpperCase();
      }
      const balance = first.length > 6 ? parsePlAmount(first[6]) : null;
      const date = parsePlDate(first[0]);
      if (balance !== null && date !== null) summary = { date, amount: balance };
      start = 1;
    }
  }

  const transactions: DocTransaction[] = [];
  for (const row of rows.slice(start)) {
    if (row.length < 6) continue;
    const booking = parsePlDate(pyStripChars(pyStrip(row[0]), "'", true, false));
    const amount = parsePlAmount(row[5]);
    if (booking === null || amount === null) continue;
    const title = cellAt(row, 2);
    transactions.push({
      booking_date: booking,
      value_date: parsePlDate(row[1]),
      amount,
      currency,
      counterparty_name: cellAt(row, 3),
      counterparty_iban: cellAt(row, 4),
      description: title,
      reference: title,
      balance_after: row.length > 6 ? parsePlAmount(row[6]) : null,
    });
  }
  if (!accountNumber) accountNumber = findAccountNumber(text);

  // The summary balance was a running balance listed before the rows: the import's end-of-day
  // logic let it win on its date when the rows run newest first (the usual order), and let a row of
  // that date win when they run oldest first. An explicit balance always wins, so it is sent only
  // when it won before.
  const balances: { date: string; amount: string }[] = [];
  if (summary !== null) {
    const dates = transactions.map((t) => t.booking_date);
    const descending = dates.length >= 2 && dates[0] > dates[dates.length - 1];
    const rowWins = transactions.some(
      (t) => t.booking_date === summary!.date && t.balance_after !== null,
    );
    if (descending || !rowWins) balances.push(summary);
  }
  return {
    institution: "erste",
    source: "erste_csv",
    accountNumber,
    currency,
    transactions,
    balances,
  };
}

/** The structural signal: the first non-blank line is comma-separated, 7+ cells, one of them an
 * apostrophe-guarded account number (the summary row). Checked on the raw line, as the former
 * built-in detection did, and on the CSV-parsed record (a quoted cell starts with `"`, not `'`). */
function summaryRowShape(text: string): boolean {
  const looksLikeSummary = (cells: string[]) =>
    cells.length >= 7 &&
    cells.some((c) => pyStrip(c).startsWith("'") && findAccountNumber(c) !== null);
  for (const line of pySplitlines(text)) {
    if (!pyStrip(line)) continue;
    if (looksLikeSummary(line.split(","))) return true;
    const record = csvRows(line, ",")[0] ?? [];
    return looksLikeSummary(record);
  }
  return false;
}

/** How strongly the file looks like an Erste / Santander export: the former built-in score (bank
 * names + the summary row shape), and only when the file really converts (at least one row). */
export function detect(bytes: Uint8Array): number {
  const text = readText(bytes, ENCODINGS);
  const low = text.toLowerCase();
  let score = SIGNATURE.filter((sig) => low.includes(sig)).length;
  if (summaryRowShape(text)) score += 2;
  if (score === 0) return 0;
  try {
    if (!parse(bytes).transactions.length) return 0;
  } catch {
    return 0;
  }
  return Math.min(0.95, 0.5 + 0.1 * score);
}
