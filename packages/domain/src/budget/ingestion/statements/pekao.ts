/**
 * Bank Pekao CSV export (Python `csv_import/pekao.py`): UTF-8, `;`-delimited, a header row, account
 * numbers apostrophe-guarded, no running balance. Each row carries a source and a destination account;
 * the own account is the one seen most often, the counterparty the other side.
 */

import type { PyCodec } from "../../../codecs.js";
import { readCsv } from "../../../pycsv.js";
import { pyLower, pyStrip, pyStripChars } from "../../../text.js";
import { parsePlDate } from "../plFormats.js";
import type { ParsedStatement, RawTransaction } from "../types.js";
import { amountOrRefuse, readStatementText } from "./delimited.js";
import { refuse } from "./result.js";

/** @package */
export const PEKAO_ENCODINGS: readonly PyCodec[] = ["utf-8-sig", "utf-8", "cp1250", "iso-8859-2"];
/** @package Declared like Python's; the parser always reads `;` (as Python did). */
export const PEKAO_DELIMITERS: readonly string[] = [";", ","];
/** @package */
export const PEKAO_SIGNATURE: readonly string[] = [
  "rachunek źródłowy",
  "rachunek docelowy",
  "numer referencyjny",
  "typ operacji",
];
/** @package Column aliases; the key order is the matching order. */
export const PEKAO_COLS = {
  booking: ["data księgowania", "data ksiegowania"],
  value: ["data waluty"],
  counterparty: ["nadawca / odbiorca", "nadawca/odbiorca"],
  source: ["rachunek źródłowy", "rachunek zrodlowy"],
  dest: ["rachunek docelowy"],
  title: ["tytułem", "tytulem"],
  amount: ["kwota operacji", "kwota"],
  currency: ["waluta"],
  type: ["typ operacji"],
} as const satisfies Record<string, readonly string[]>;

type Col = keyof typeof PEKAO_COLS;
const REQUIRED: readonly Col[] = ["booking", "amount", "source", "dest"];

/** `_acct`: an account cell without the apostrophe guard and ASCII spaces. */
function acct(cell: string | null | undefined): string | null {
  if (!cell) return null;
  return pyStripChars(pyStrip(cell), "'", "left").replaceAll(" ", "") || null;
}

function findHeader(
  rows: readonly (readonly string[])[],
): { index: number; idx: Partial<Record<Col, number>> } | null {
  for (const [index, row] of rows.entries()) {
    const low = row.map((c) => pyLower(pyStrip(c)));
    const idx: Partial<Record<Col, number>> = {};
    for (const [field, cands] of Object.entries(PEKAO_COLS) as [Col, readonly string[]][]) {
      const j = low.findIndex((cell) => cell !== "" && cands.some((c) => cell.includes(c)));
      if (j >= 0) idx[field] = j;
    }
    if (REQUIRED.every((f) => idx[f] !== undefined)) return { index, idx };
  }
  return null;
}

export function pekaoScore(text: string): number {
  const low = pyLower(text);
  return PEKAO_SIGNATURE.filter((sig) => low.includes(pyLower(sig))).length;
}

export function parsePekao(bytes: Uint8Array): ParsedStatement {
  const text = readStatementText(bytes, PEKAO_ENCODINGS);
  const records = readCsv(text, { delimiter: ";" });
  // PARITY(Q11): a csv.Error (e.g. a field over 131072 code points) refuses the whole file, as in Python.
  if (!records.ok) refuse({ ok: false, reason: "bad_csv", line: records.lineNum });
  const rows = records.rows
    .map((cells, i) => ({ cells, record: i + 1 }))
    .filter(({ cells }) => cells.some((c) => pyStrip(c)));
  const header = findHeader(rows.map((r) => r.cells));
  if (header === null) refuse({ ok: false, reason: "no_header" });
  const { idx } = header;
  const data = rows.slice(header.index + 1);

  // Own account = the one seen most often in the source / destination columns (ties: seen first).
  const counter = new Map<string, number>();
  for (const { cells } of data) {
    for (const f of ["source", "dest"] as const) {
      const j = idx[f] as number;
      const a = j < cells.length ? acct(cells[j]) : null;
      if (a) counter.set(a, (counter.get(a) ?? 0) + 1);
    }
  }
  let own: string | null = null;
  let best = 0;
  for (const [a, n] of counter) {
    if (n > best) {
      own = a;
      best = n;
    }
  }

  const transactions: RawTransaction[] = [];
  let skippedRows = 0;
  for (const { cells: row, record } of data) {
    const cell = (f: Col): string | null => {
      const j = idx[f];
      return j !== undefined && j < row.length ? pyStrip(row[j] as string) || null : null;
    };
    const booking = parsePlDate(cell("booking"));
    const amount = amountOrRefuse(cell("amount"), record);
    if (booking === null || amount === null) {
      skippedRows++;
      continue;
    }
    const src = acct(cell("source"));
    const dst = acct(cell("dest"));
    const title = cell("title");
    transactions.push({
      bookingDate: booking,
      valueDate: parsePlDate(cell("value")),
      amount,
      currency: cell("currency") ?? "PLN",
      counterpartyName: cell("counterparty"),
      counterpartyIban: own ? (src === own ? dst : src) : (dst ?? src),
      // PARITY(Q5): description and reference are both the title.
      description: title,
      reference: title,
      // PARITY(Q8): `Numer referencyjny` is not used as the bank transaction id.
      bankTransactionId: null,
      source: "csv",
      raw: { row, type: cell("type") },
    });
  }
  return {
    bank: "pekao",
    accountNumber: own,
    accountNumberOrigin: own === null ? null : "inferred",
    accountName: null,
    // PARITY(Q12): the statement currency is always PLN (rows keep their own).
    currency: "PLN",
    transactions,
    balances: [],
    closingBalances: [],
    skippedRows,
  };
}
