/**
 * Broker import contract: what every importer receives and returns (pure data, no I/O).
 *
 * Port of `importing/contract.py`; the Python docstring is the contract note:
 *
 * - Importers are pure: they get an `ImportFile` (name + raw bytes) and return an `ImportParseResult`;
 *   no database, no file system, no network. Row problems become `ImportWarning` values, never
 *   exceptions (`blocking` prevents committing the import).
 * - Sign conventions are those of `Transaction`: `quantity` and `grossAmount` are >= 0, the direction
 *   comes from `type`; `cashAmount` is the signed net cash effect in `cashCurrency`; `fxRate` is units of
 *   `cashCurrency` per 1 unit of `currency` when they differ.
 * - `rowIndex` (records) and `ImportWarning.row` are the 0-based index of the data row in the file
 *   (after the header); file-level warnings have `row` null.
 * - `tradeTime` is only a same-day sort key (the stored trade date stays a calendar date).
 * - Renames and delistings are not transactions: they travel as `ParsedCorporateAction`; splits stay
 *   `split` transactions.
 * - Every value is frozen; sequences are readonly arrays; `rawRow` is a read-only map (column header ->
 *   raw cell text, in file order; a Map because a header may be any string, even an integer-like one).
 */

import { type Decimal, ZERO } from "../../decimal.js";
import { pyLower, pyStrip } from "../../text.js";
import type { CalendarDate, Currency, Init, TxnType } from "../domain/index.js";
import { withDefaults } from "../domain/index.js";

/** A file picked by the user: original name plus raw bytes. */
export interface ImportFile {
  /** Original file name, e.g. `xtb_2026.csv`. */
  readonly name: string;
  readonly content: Uint8Array;
}

/**
 * `ImportFile.extension`: the lower-case text after the last dot of the file name, without the dot, or
 * an empty string. Python 3.14 `PurePath.suffix`: the last path component (POSIX separators; empty and
 * `.` components dropped), leading dots ignored, so `..a` and `.hidden` have none and `a.` has the
 * empty one.
 */
export function importFileExtension(file: ImportFile): string {
  const parts = file.name.split("/").filter((part) => part !== "" && part !== ".");
  const name = (parts[parts.length - 1] ?? "").replace(/^\.+/u, "");
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : pyLower(name.slice(dot + 1));
}

/** A parser for one broker's export format. Pure: no database, no file system, no network. */
export interface BrokerImporter {
  /** Stable broker id (`xtb`, `generic_csv`), also the alias namespace of the broker's symbols. */
  readonly brokerId: string;
  /** Name shown in the UI. */
  readonly displayName: string;
  /** Version of the parsing logic (stored on the import batch); bump when parsing changes. */
  readonly version: number;
  /**
   * Cheap sniff (extension, header row) whether this importer understands `file`. Must not throw for
   * foreign files (the registry treats an exception as "no").
   */
  canParse(file: ImportFile): boolean;
  /** Normalized rows plus warnings. Problems with single rows become warnings, never exceptions. */
  parse(file: ImportFile): ImportParseResult;
}

/** A time of day (Python `datetime.time` without zone or microseconds). */
export interface TimeOfDay {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/** One normalized transaction row of an export, before instrument resolution and dedup. */
export interface ParsedTxn {
  /** 0-based index of the data row in the file (after the header): messages and dedup order. */
  readonly rowIndex: number;
  readonly tradeDate: CalendarDate;
  readonly type: TxnType;
  /** Currency of `price`, `grossAmount`, `fee` and `tax`. */
  readonly currency: Currency;
  /** Absolute value before fees and taxes (quantity * price for trades), >= 0. */
  readonly grossAmount: Decimal;
  /** Signed net effect on cash in `cashCurrency` (a buy is negative). */
  readonly cashAmount: Decimal;
  readonly cashCurrency: Currency;
  /** The broker's own id of the row or order, if the export has one. */
  readonly externalRef: string | null;
  /** Time of day when the export has one; only a sort key for rows of the same `tradeDate`. */
  readonly tradeTime: TimeOfDay | null;
  readonly settleDate: CalendarDate | null;
  /** Instrument hints for the resolver (any may be null; cash rows have none). */
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string | null;
  /** Exchange as written in the export (`GPW`, `XWAR`, `.PL` suffix). */
  readonly exchangeHint: string | null;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly fee: Decimal;
  readonly tax: Decimal;
  /** Units of `cashCurrency` per 1 unit of `currency` when they differ. */
  readonly fxRate: Decimal | null;
  /** For `split`: new units per old unit (a 1:4 split is 4). */
  readonly splitRatio: Decimal | null;
  readonly note: string | null;
  /** The source row as column header -> raw cell text (previews, debugging). */
  readonly rawRow: ReadonlyMap<string, string>;
}

export type ParsedTxnInit = Init<
  ParsedTxn,
  | "externalRef"
  | "tradeTime"
  | "settleDate"
  | "symbol"
  | "isin"
  | "name"
  | "exchangeHint"
  | "quantity"
  | "price"
  | "fee"
  | "tax"
  | "fxRate"
  | "splitRatio"
  | "note"
  | "rawRow"
>;

/** `ParsedTxn(...)`: Python's keyword defaults, frozen. */
export function parsedTxn(init: ParsedTxnInit): ParsedTxn {
  return withDefaults<ParsedTxn>(
    {
      externalRef: null,
      tradeTime: null,
      settleDate: null,
      symbol: null,
      isin: null,
      name: null,
      exchangeHint: null,
      quantity: null,
      price: null,
      fee: ZERO,
      tax: ZERO,
      fxRate: null,
      splitRatio: null,
      note: null,
      rawRow: new Map(),
    },
    init,
  );
}

/** `ParsedTxn.instrument_named`: the row names an instrument (a non-blank symbol, ISIN or name). */
export function instrumentNamed(txn: ParsedTxn): boolean {
  return [txn.symbol, txn.isin, txn.name].some((value) => value !== null && pyStrip(value) !== "");
}

/** One line of a broker position export (reconciliation input). */
export interface ParsedPosition {
  readonly quantity: Decimal;
  readonly currency: Currency;
  readonly asOf: CalendarDate;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly name: string | null;
  readonly exchangeHint: string | null;
  readonly avgPrice: Decimal | null;
  readonly marketValue: Decimal | null;
}

export type ParsedPositionInit = Init<
  ParsedPosition,
  "symbol" | "isin" | "name" | "exchangeHint" | "avgPrice" | "marketValue"
>;

/** `ParsedPosition(...)` with Python's defaults. */
export function parsedPosition(init: ParsedPositionInit): ParsedPosition {
  return withDefaults<ParsedPosition>(
    { symbol: null, isin: null, name: null, exchangeHint: null, avgPrice: null, marketValue: null },
    init,
  );
}

/** Fields every corporate action shares (`ParsedCorporateAction`). */
interface ParsedActionBase {
  /** Effective date of the action. */
  readonly date: CalendarDate;
  readonly rowIndex: number | null;
  readonly note: string | null;
}

/**
 * The instrument known as `oldSymbol` continues as `newSymbol` (ticker change, merger into a
 * successor). Lots carry over; this is not a sell plus a buy.
 */
export interface ParsedRename extends ParsedActionBase {
  readonly kind: "rename";
  readonly oldSymbol: string;
  readonly newSymbol: string;
  readonly oldIsin: string | null;
  readonly newIsin: string | null;
  /** Exchange of the old listing (MIC or broker hint). */
  readonly exchangeHint: string | null;
  /** Exchange of the new listing when it differs. */
  readonly newExchangeHint: string | null;
  readonly newName: string | null;
}

export type ParsedRenameInit = Init<
  ParsedRename,
  | "kind"
  | "rowIndex"
  | "note"
  | "oldIsin"
  | "newIsin"
  | "exchangeHint"
  | "newExchangeHint"
  | "newName"
>;

/** `ParsedRename(...)` with Python's defaults. */
export function parsedRename(init: ParsedRenameInit): ParsedRename {
  return withDefaults<ParsedRename>(
    {
      kind: "rename",
      rowIndex: null,
      note: null,
      oldIsin: null,
      newIsin: null,
      exchangeHint: null,
      newExchangeHint: null,
      newName: null,
    },
    init,
  );
}

/**
 * The instrument stopped trading. `frozen` marks a holding that cannot be sold or priced (a sanctioned
 * ADR), as opposed to an ordinary delisting with a final cash-out.
 */
export interface ParsedDelisting extends ParsedActionBase {
  readonly kind: "delisting";
  readonly symbol: string;
  readonly isin: string | null;
  readonly exchangeHint: string | null;
  readonly frozen: boolean;
}

export type ParsedDelistingInit = Init<
  ParsedDelisting,
  "kind" | "rowIndex" | "note" | "isin" | "exchangeHint" | "frozen"
>;

/** `ParsedDelisting(...)` with Python's defaults. */
export function parsedDelisting(init: ParsedDelistingInit): ParsedDelisting {
  return withDefaults<ParsedDelisting>(
    {
      kind: "delisting",
      rowIndex: null,
      note: null,
      isin: null,
      exchangeHint: null,
      frozen: false,
    },
    init,
  );
}

/** Corporate actions that are not cash or quantity movements by themselves; match on `kind`. */
export type ParsedCorporateAction = ParsedRename | ParsedDelisting;

/** Stable kinds of `ImportWarning` (the values are the wire names). */
export const ImportWarningKind = Object.freeze({
  /** Undecodable text, broken CSV / JSON, missing header, wrong format or version. */
  FILE_FORMAT: "file_format",
  /** A mapped or required column is missing from the header. */
  MISSING_COLUMN: "missing_column",
  /** An unknown column, key or field (canonical format), or a field not allowed for the record. */
  UNKNOWN_FIELD: "unknown_field",
  /** A required value is empty. */
  MISSING_VALUE: "missing_value",
  /** A value that cannot be read: number, date, time, currency, ISIN, boolean, text length. */
  INVALID_VALUE: "invalid_value",
  /** A broker type string with no transaction type (add it to the mapping). */
  UNMAPPED_TYPE: "unmapped_type",
  /** A row skipped on purpose (type mapped to ignore, row without date and type, skip policy). */
  IGNORED_ROW: "ignored_row",
  /** A cross-currency amount cannot be derived without `fx_rate` (R5). */
  FX_MISSING: "fx_missing",
  /** Amounts missing or inconsistent (no amount at all, fee and tax exceed the cash amount). */
  AMOUNT: "amount",
  /** A given cash amount disagrees with gross, fee and tax. */
  AMOUNT_MISMATCH: "amount_mismatch",
  /** The sign of `cash_amount` contradicts the transaction type. */
  CASH_SIGN: "cash_sign",
  /** A row that needs an instrument names none (or names one it must not). */
  MISSING_INSTRUMENT: "missing_instrument",
  /** A row that needs a quantity has none (or has one it must not). */
  MISSING_QUANTITY: "missing_quantity",
  /** A split without a positive split ratio. */
  UNKNOWN_SPLIT_RATIO: "unknown_split_ratio",
  /** A negative quantity or gross amount. */
  NEGATIVE_AMOUNT: "negative_amount",
  /** File-level values (source, account hint) differ between rows. */
  INCONSISTENT_FILE: "inconsistent_file",
  /** Position records with several dates or repeated instruments. */
  POSITION_SNAPSHOT: "position_snapshot",
  /** Resolver notes: conflicting ISIN / broker symbol, ambiguous symbol, currency disagreement. */
  INSTRUMENT_NOTE: "instrument_note",
  /** A corporate action names an instrument that is not known. */
  UNKNOWN_INSTRUMENT: "unknown_instrument",
  /** The file suggests missing history (e.g. a sale before any purchase); for importers. */
  HISTORY_GAP_HINT: "history_gap_hint",
  /** The importer failed or did not recognize the file. */
  IMPORTER_ERROR: "importer_error",
  OTHER: "other",
} as const);
export type ImportWarningKind = (typeof ImportWarningKind)[keyof typeof ImportWarningKind];
export const IMPORT_WARNING_KINDS: readonly ImportWarningKind[] = Object.freeze(
  Object.values(ImportWarningKind),
);

/** A parse problem. `blocking` warnings prevent committing the import. */
export interface ImportWarning {
  readonly message: string;
  /** 0-based data row the warning refers to (`ParsedTxn.rowIndex`), null for file-level problems. */
  readonly row: number | null;
  readonly blocking: boolean;
  /**
   * Stable machine-readable category for grouping in UIs and reports (an `ImportWarningKind` value;
   * importers may use their own snake_case kinds).
   */
  readonly kind: string;
}

export type ImportWarningInit = Init<ImportWarning, "row" | "blocking" | "kind">;

/** `ImportWarning(...)` with Python's defaults (row null, not blocking, kind `other`). */
export function importWarning(init: ImportWarningInit): ImportWarning {
  return withDefaults<ImportWarning>(
    { row: null, blocking: false, kind: ImportWarningKind.OTHER },
    init,
  );
}

/** A blocking warning (`_blocking` of the importers). */
export function blockingWarning(
  row: number | null,
  message: string,
  kind: string = ImportWarningKind.INVALID_VALUE,
): ImportWarning {
  return importWarning({ message, row, blocking: true, kind });
}

/** `ImportWarning.code`: stable machine-readable code for a translated label, `import.<kind>`. */
export function warningCode(warning: ImportWarning): string {
  return `import.${warning.kind || "other"}`;
}

/** `str(warning)`: `row 3: message (blocking)`. */
export function warningText(warning: ImportWarning): string {
  const prefix = warning.row === null ? "" : `row ${warning.row}: `;
  return `${prefix}${warning.message}${warning.blocking ? " (blocking)" : ""}`;
}

/** Python dataclass value identity of a warning (`set` / `==`): one string per distinct warning. */
export function warningKey(warning: ImportWarning): string {
  return JSON.stringify([warning.message, warning.row, warning.blocking, warning.kind]);
}

/** Everything an importer extracted from one file. */
export interface ImportParseResult {
  readonly txns: readonly ParsedTxn[];
  readonly positions: readonly ParsedPosition[];
  readonly warnings: readonly ImportWarning[];
  /** Renames and delistings detected in the file (applied by the import service). */
  readonly corporateActions: readonly ParsedCorporateAction[];
  /** Account number / name found in the file, to suggest the target account. */
  readonly accountHint: string | null;
  /**
   * Broker the data came from when the file says so (canonical format `source`). When set, the import
   * uses it instead of the importer's `brokerId` as the alias namespace of the file's symbols and as
   * the batch's broker label (see `effectiveBrokerId`).
   */
  readonly source: string | null;
}

export type ImportParseResultInit = Partial<ImportParseResult>;

/** `ImportParseResult(...)`: empty sequences and null hints by default, arrays copied and frozen. */
export function importParseResult(init: ImportParseResultInit = {}): ImportParseResult {
  return Object.freeze({
    txns: Object.freeze([...(init.txns ?? [])]),
    positions: Object.freeze([...(init.positions ?? [])]),
    warnings: Object.freeze([...(init.warnings ?? [])]),
    corporateActions: Object.freeze([...(init.corporateActions ?? [])]),
    accountHint: init.accountHint ?? null,
    source: init.source ?? null,
  });
}

/** `ImportParseResult.has_blocking_warnings`. */
export function hasBlockingWarnings(result: ImportParseResult): boolean {
  return result.warnings.some((warning) => warning.blocking);
}

/** Alias namespace of the canonical format (`CANONICAL_BROKER_ID`). */
export const CASHU_NAMESPACE = "cashu";
/** The same namespace before the rename (legacy name); aliases stored under it still resolve. */
export const LEGACY_NAMESPACE = "finanse";

/** `brokerId` with the pre-rename canonical namespace read as the current one. */
export function namespaceOf(brokerId: string): string {
  return brokerId === LEGACY_NAMESPACE ? CASHU_NAMESPACE : brokerId;
}

/** Namespaces that name the same aliases: `cashu` and its legacy name `finanse`. */
export function equivalentNamespaces(namespace: string): readonly string[] {
  return namespace === CASHU_NAMESPACE || namespace === LEGACY_NAMESPACE
    ? [CASHU_NAMESPACE, LEGACY_NAMESPACE]
    : [namespace];
}

/**
 * Alias namespace / broker label of an import: the file's `source` when set (and not empty), else the
 * importer's `brokerId` (legacy name: `source: finanse` reads as `cashu`).
 */
export function effectiveBrokerId(importer: BrokerImporter, result: ImportParseResult): string {
  return namespaceOf(result.source || importer.brokerId);
}
