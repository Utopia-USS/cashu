/**
 * Constants of the canonical `cashu-import` format (format_version 1): ids, limits, the record kinds
 * and which kind accepts which field. Spec: `docs/import-format.md`.
 */

import { Decimal } from "../../../decimal.js";
import { TxnType } from "../../domain/index.js";
import { CASHU_NAMESPACE, LEGACY_NAMESPACE } from "../contract.js";

/** Broker id of the canonical importer (alias namespace when a file sets no `source`). */
export const CANONICAL_BROKER_ID = CASHU_NAMESPACE;
export const CANONICAL_FORMAT = "cashu-import";
export const CANONICAL_FORMAT_VERSION = 1;
// legacy name: the ids before the rename, still accepted (deprecated) and read as the new ones
export const LEGACY_BROKER_ID = LEGACY_NAMESPACE;
export const LEGACY_FORMAT = "finanse-import";

/** An importer id as stored or sent, with the pre-rename `finanse` (legacy name) read as `cashu`. */
export function canonicalImporterId(value: string | null): string | null {
  return value === LEGACY_BROKER_ID ? CANONICAL_BROKER_ID : value;
}

export const CSV_EXTENSIONS: readonly string[] = ["csv", "txt"];
export const JSON_EXTENSIONS: readonly string[] = ["json"];
export const SNIFF_BYTES = 64 * 1024;

/** Allowed difference between a given cash amount and the one implied by gross, fee and tax. */
export const CONSISTENCY_TOLERANCE = Decimal.parse("0.01");

export const MAX_SYMBOL = 64;
export const MAX_NAME = 200;
export const MAX_REF = 200;
export const MAX_NOTE = 1000;
export const MAX_ACCOUNT_HINT = 200;
export const MAX_SOURCE = 32;

/** Kind of a canonical record (the `record` field). */
export const RecordKind = Object.freeze({
  TXN: "txn",
  POSITION: "position",
  RENAME: "rename",
  DELISTING: "delisting",
} as const);
export type RecordKind = (typeof RecordKind)[keyof typeof RecordKind];
export const RECORD_KINDS: readonly RecordKind[] = Object.freeze(Object.values(RecordKind));

const TXN: ReadonlySet<RecordKind> = new Set([RecordKind.TXN]);
const POS: ReadonlySet<RecordKind> = new Set([RecordKind.POSITION]);
const ANY: ReadonlySet<RecordKind> = new Set(RECORD_KINDS);
const INSTRUMENT_KINDS: ReadonlySet<RecordKind> = new Set([RecordKind.TXN, RecordKind.POSITION]);
const RENAME: ReadonlySet<RecordKind> = new Set([RecordKind.RENAME]);
const DELISTING: ReadonlySet<RecordKind> = new Set([RecordKind.DELISTING]);

/** Record field -> record kinds that accept it (in the recommended column order). */
export const RECORD_FIELDS: ReadonlyMap<string, ReadonlySet<RecordKind>> = new Map([
  ["record", ANY],
  ["date", ANY],
  ["time", TXN],
  ["settle_date", TXN],
  ["type", TXN],
  ["external_ref", TXN],
  ["symbol", ANY],
  ["isin", ANY],
  ["name", INSTRUMENT_KINDS],
  ["exchange", ANY],
  ["quantity", INSTRUMENT_KINDS],
  ["price", TXN],
  ["currency", INSTRUMENT_KINDS],
  ["gross_amount", TXN],
  ["fee", TXN],
  ["tax", TXN],
  ["cash_amount", TXN],
  ["cash_currency", TXN],
  ["fx_rate", TXN],
  ["split_ratio", TXN],
  ["avg_price", POS],
  ["market_value", POS],
  ["new_symbol", RENAME],
  ["new_isin", RENAME],
  ["new_exchange", RENAME],
  ["new_name", RENAME],
  ["frozen", DELISTING],
  ["note", ANY],
]);

export const FILE_FIELDS: readonly string[] = ["format_version", "source", "account_hint"];
/** Every CSV column, in the recommended order. */
export const CSV_COLUMNS: readonly string[] = [
  "format_version",
  ...RECORD_FIELDS.keys(),
  "source",
  "account_hint",
];
export const REQUIRED_CSV_COLUMNS: readonly string[] = ["format_version", "record", "date"];
export const JSON_TOP_LEVEL_KEYS: readonly string[] = [
  "format",
  "format_version",
  "source",
  "account_hint",
  "records",
];

export const INSTRUMENT_REQUIRED: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.SPLIT,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);
export const INSTRUMENT_FORBIDDEN: ReadonlySet<TxnType> = new Set([
  TxnType.DEPOSIT,
  TxnType.WITHDRAWAL,
  TxnType.FX_CONVERSION,
]);
export const QUANTITY_REQUIRED: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.SELL,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);
export const QUANTITY_FORBIDDEN: ReadonlySet<TxnType> = new Set([
  TxnType.INTEREST,
  TxnType.DEPOSIT,
  TxnType.WITHDRAWAL,
  TxnType.FEE,
  TxnType.TAX,
  TxnType.FX_CONVERSION,
]);
export const CASH_NOT_POSITIVE_ERROR: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.WITHDRAWAL,
]);
export const CASH_NOT_NEGATIVE_ERROR: ReadonlySet<TxnType> = new Set([
  TxnType.SELL,
  TxnType.DEPOSIT,
]);
export const CASH_NOT_POSITIVE_WARNING: ReadonlySet<TxnType> = new Set([TxnType.FEE, TxnType.TAX]);
export const CASH_NOT_NEGATIVE_WARNING: ReadonlySet<TxnType> = new Set([
  TxnType.DIVIDEND,
  TxnType.INTEREST,
]);

// Value shapes. Cells are stripped before they reach these, so `$` has no trailing-newline case.
export const DATE_RE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/u;
export const TIME_RE = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?$/u;
export const NUMBER_RE = /^-?[0-9]+(\.[0-9]+)?$/u;
export const CURRENCY_RE = /^[A-Z]{3}$/u;
export const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u;
export const SOURCE_RE = /^[a-z][a-z0-9_]*$/u;
