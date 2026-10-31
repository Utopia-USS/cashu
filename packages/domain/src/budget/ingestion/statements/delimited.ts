/**
 * The header-row statement engine shared by the bank parsers (Python `csv_import/base.py`
 * `DelimitedImporter`): decode with the bank's encodings, sniff the delimiter, find the header row by
 * column-name substrings, map each later row to a `RawTransaction`.
 */

import { decodeFirst, type PyCodec, translateNewlines } from "../../../codecs.js";
import type { Decimal } from "../../../decimal.js";
import { readCsv } from "../../../pycsv.js";
import { pyLower, pySplitlines, pyStrip } from "../../../text.js";
import { findAccountNumber, parsePlAmount, parsePlDate } from "../plFormats.js";
import type {
  AccountNumberOrigin,
  DatedAmount,
  ParsedStatement,
  RawTransaction,
} from "../types.js";
import { refuse } from "./result.js";

/** Header-substring candidates per field (case-insensitive), Python `ColumnMap`. */
export interface ColumnMap {
  readonly booking_date: readonly string[];
  readonly value_date: readonly string[];
  readonly amount: readonly string[];
  readonly counterparty: readonly string[];
  readonly description: readonly string[];
  readonly title: readonly string[];
  readonly counterparty_iban: readonly string[];
  readonly currency: readonly string[];
  readonly balance: readonly string[];
  /** Separate outflow column (positive magnitude). */
  readonly debit: readonly string[];
  /** Separate inflow column. */
  readonly credit: readonly string[];
}

type Field = keyof ColumnMap;
type Mapping = Partial<Record<Field, number>>;

/** `_match_header`'s field order: a field takes the first matching cell, in this order. */
const HEADER_FIELDS: readonly Field[] = [
  "booking_date",
  "value_date",
  "amount",
  "counterparty",
  "description",
  "title",
  "counterparty_iban",
  "currency",
  "balance",
  "debit",
  "credit",
];

export const DEFAULT_ENCODINGS: readonly PyCodec[] = ["utf-8-sig", "cp1250", "iso-8859-2", "utf-8"];
export const DEFAULT_DELIMITERS: readonly string[] = [";", ",", "\t"];

export interface StatementMeta {
  readonly accountNumber: string | null;
  readonly origin: AccountNumberOrigin | null;
  readonly currency: string;
}

export interface DelimitedConfig {
  readonly bank: string;
  readonly encodings: readonly PyCodec[];
  readonly delimiters: readonly string[];
  readonly colmap: ColumnMap;
  /** Account and currency from the whole text; default: the first account number anywhere, PLN. */
  readonly extractMeta?: (text: string) => StatementMeta;
}

/** `_read_text`: the first encoding that decodes, newlines translated; none -> refuse. */
export function readStatementText(bytes: Uint8Array, encodings: readonly PyCodec[]): string {
  const decoded = decodeFirst(bytes, encodings);
  if (!decoded.ok) refuse({ ok: false, reason: "undecodable" });
  return translateNewlines(decoded.text);
}

/** `_sniff_delimiter`: the delimiter seen most often in one of the first 50 lines (ties: earlier). */
function sniffDelimiter(lines: readonly string[], delimiters: readonly string[]): string {
  let best = delimiters[0] ?? ";";
  let bestCount = -1;
  for (const d of delimiters) {
    let count = 0;
    for (const line of lines.slice(0, 50)) count = Math.max(count, line.split(d).length - 1);
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** `_match_header`: field -> column when this row is a header (a date and some amount column). */
function matchHeader(row: readonly string[], colmap: ColumnMap): Mapping | null {
  const lowered = row.map((c) => pyLower(pyStrip(c)));
  const mapping: Mapping = {};
  for (const f of HEADER_FIELDS) {
    const idx = lowered.findIndex(
      (cell) => cell !== "" && colmap[f].some((cand) => cell.includes(cand)),
    );
    if (idx >= 0) mapping[f] = idx;
  }
  const hasAmount =
    mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined;
  return mapping.booking_date !== undefined && hasAmount ? mapping : null;
}

function defaultMeta(text: string): StatementMeta {
  const accountNumber = findAccountNumber(text);
  return { accountNumber, origin: accountNumber === null ? null : "scan", currency: "PLN" };
}

/** `parse_pl_amount`, refusing the file (with the record number) where Python raised. PARITY(Q1). */
export function amountOrRefuse(value: string | null, record: number): Decimal | null {
  const amount = parsePlAmount(value);
  if (amount === "invalid") refuse({ ok: false, reason: "bad_amount", row: record });
  return amount;
}

/** `DelimitedImporter.parse` (call inside `refusing`). */
export function parseDelimited(bytes: Uint8Array, config: DelimitedConfig): ParsedStatement {
  const text = readStatementText(bytes, config.encodings);
  const delimiter = sniffDelimiter(pySplitlines(text), config.delimiters);
  const records = readCsv(text, { delimiter });
  if (!records.ok) refuse({ ok: false, reason: "bad_csv", line: records.lineNum });
  const reader = records.rows;

  let headerIdx = -1;
  let mapping: Mapping = {};
  for (const [i, row] of reader.entries()) {
    const m = matchHeader(row, config.colmap);
    if (m) {
      headerIdx = i;
      mapping = m;
      break;
    }
  }
  if (headerIdx < 0) refuse({ ok: false, reason: "no_header" });

  const meta = (config.extractMeta ?? defaultMeta)(text);
  const cell = (row: readonly string[], f: Field): string | null => {
    const idx = mapping[f];
    if (idx === undefined || idx >= row.length) return null;
    return pyStrip(row[idx] as string) || null;
  };
  const amountOf = (row: readonly string[], record: number): Decimal | null => {
    if (mapping.amount !== undefined) return amountOrRefuse(cell(row, "amount"), record);
    const debit = amountOrRefuse(cell(row, "debit"), record);
    const credit = amountOrRefuse(cell(row, "credit"), record);
    if (credit !== null && !credit.isZero()) return credit.abs();
    if (debit !== null && !debit.isZero()) return debit.abs().neg();
    return null;
  };

  const transactions: RawTransaction[] = [];
  const balances: DatedAmount[] = [];
  let skippedRows = 0;
  for (let i = headerIdx + 1; i < reader.length; i++) {
    const row = reader[i] as string[];
    const record = i + 1;
    // `_row_to_txn`: the amount is evaluated even when the date is missing (a footer can refuse).
    const booking = parsePlDate(cell(row, "booking_date"));
    const amount = amountOf(row, record);
    if (booking === null || amount === null) {
      if (row.some((c) => pyStrip(c))) skippedRows++;
      continue;
    }
    transactions.push({
      bookingDate: booking,
      valueDate: parsePlDate(cell(row, "value_date")),
      amount,
      currency: cell(row, "currency") ?? meta.currency,
      counterpartyName: cell(row, "counterparty"),
      counterpartyIban: cell(row, "counterparty_iban"),
      description: cell(row, "description") ?? cell(row, "title"),
      reference: cell(row, "title"),
      bankTransactionId: null,
      source: "csv",
      raw: { row },
    });
    if (mapping.balance !== undefined) {
      const balance = amountOrRefuse(cell(row, "balance"), record);
      if (balance !== null) balances.push({ date: booking, amount: balance });
    }
  }

  return {
    bank: config.bank,
    accountNumber: meta.accountNumber,
    accountNumberOrigin: meta.origin,
    accountName: null,
    currency: meta.currency,
    transactions,
    balances,
    closingBalances: [],
    skippedRows,
  };
}
