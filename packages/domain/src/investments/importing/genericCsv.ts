/** Importer for any delimited text export, driven by a `CsvMapping` (port of `importing/generic_csv.py`). */

import { type Decimal, ZERO } from "../../decimal.js";
import { type Currency, tryCurrency } from "../../money.js";
import { csvErrorMessage, readCsv } from "../../pycsv.js";
import { pyLower, pyStrip, pyUpper } from "../../text.js";
import { isTxnType, type TxnType } from "../domain/index.js";
import { deriveAmounts, signedCash } from "./cash.js";
import {
  type BrokerImporter,
  blockingWarning,
  type ImportFile,
  type ImportParseResult,
  type ImportWarning,
  ImportWarningKind,
  importFileExtension,
  importParseResult,
  importWarning,
  type ParsedTxn,
  parsedTxn,
} from "./contract.js";
import { AmountSign, CsvField, type CsvMapping, RowErrorPolicy } from "./csvMapping.js";
import {
  type DatedTime,
  type DatePattern,
  datePattern,
  parseDatetimeWithPatterns,
  parseDecimal,
} from "./csvValues.js";
import { decodeImportText } from "./text.js";

export const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/u;

/** How many leading bytes `GenericCsvImporter.canParse` decodes to find the header row. */
export const SNIFF_BYTES = 64 * 1024;

/** `_RowError`: a row that cannot be parsed (message and warning kind). */
interface RowError {
  readonly ok: false;
  readonly message: string;
  readonly kind: string;
}

type RowOutcome<T> = { readonly ok: true; readonly value: T } | RowError;

const ok = <T>(value: T): RowOutcome<T> => ({ ok: true, value });
const rowError = (message: string, kind: string = ImportWarningKind.INVALID_VALUE): RowError => ({
  ok: false,
  message,
  kind,
});

/**
 * A `BrokerImporter` for delimited text driven by a `CsvMapping`.
 *
 * It only produces transactions (no positions). Row problems become warnings (blocking or not per
 * `mapping.onRowError`); file-level problems (encoding, missing columns) are always blocking.
 */
export class GenericCsvImporter implements BrokerImporter {
  /** Version of the parsing logic (not of the mapping). */
  static readonly PARSER_VERSION = 1;

  readonly mapping: CsvMapping;
  private readonly datePatterns: readonly DatePattern[];
  private readonly types: ReadonlyMap<string, TxnType>;
  private readonly ignored: ReadonlySet<string>;

  constructor(mapping: CsvMapping) {
    this.mapping = mapping;
    this.datePatterns = mapping.dateFormats.map(datePattern);
    this.types = new Map([...mapping.types].map(([key, value]) => [normalize(key), value]));
    this.ignored = new Set([...mapping.ignoredTypes].map(normalize));
  }

  get brokerId(): string {
    return this.mapping.brokerId;
  }

  get displayName(): string {
    return this.mapping.displayName;
  }

  get version(): number {
    return GenericCsvImporter.PARSER_VERSION;
  }

  /** True when the extension is accepted and the header row contains every mapped column. */
  canParse(file: ImportFile): boolean {
    if (!this.mapping.extensions.includes(importFileExtension(file))) return false;
    let data = file.content;
    if (data.length > SNIFF_BYTES) {
      // Cut at a line break: 0x0A never occurs inside a multi-byte UTF-8 sequence.
      const cut = data.subarray(0, SNIFF_BYTES).lastIndexOf(0x0a);
      data = cut > 0 ? data.subarray(0, cut + 1) : data.subarray(0, SNIFF_BYTES);
    }
    const decoded = decodeImportText(data, this.mapping.encoding, { lenient: true });
    if (!decoded.ok) return false;
    const records = this.records(decoded.text);
    if (!records.ok) return false;
    const header = records.value[this.mapping.headerRow];
    if (header === undefined) return false;
    return [...this.mapping.columns.values()].every((name) => headerIndex(header, name) >= 0);
  }

  parse(file: ImportFile): ImportParseResult {
    const mapping = this.mapping;
    const decoded = decodeImportText(file.content, mapping.encoding);
    if (!decoded.ok) {
      return blocked(
        `File is not valid UTF-8 (${decoded.reason} at byte ${decoded.start}); ` +
          "set encoding to windows-1250 or auto in the mapping",
      );
    }
    const parsed = this.records(decoded.text);
    if (!parsed.ok) return blocked(`File is not readable as CSV: ${parsed.message}`);
    const records = parsed.value;
    const header = records[mapping.headerRow];
    if (header === undefined) {
      return blocked(`File has no header row at record ${mapping.headerRow}`);
    }
    const index = new Map<CsvField, number>();
    const missing: string[] = [];
    for (const [target, name] of mapping.columns) {
      const position = headerIndex(header, name);
      if (position < 0) missing.push(name);
      else index.set(target, position);
    }
    if (missing.length > 0) {
      return blocked(
        `Missing columns: ${missing.map((name) => `"${name}"`).join(", ")}`,
        ImportWarningKind.MISSING_COLUMN,
      );
    }

    const txns: ParsedTxn[] = [];
    const warnings: ImportWarning[] = [];
    const skip = mapping.onRowError === RowErrorPolicy.SKIP;
    for (let r = mapping.headerRow + 1; r < records.length; r++) {
      const cells = records[r] ?? [];
      if (cells.every((cell) => pyStrip(cell) === "")) continue;
      const rowIndex = r - mapping.headerRow - 1;
      const raw = new Map<string, string>();
      header.forEach((name, i) => {
        raw.set(name, cells[i] ?? "");
      });
      const outcome = this.parseRow(new Row(rowIndex, cells, index, raw), warnings);
      if (!outcome.ok) {
        warnings.push(
          importWarning({
            message: skip ? `${outcome.message}; row skipped` : outcome.message,
            row: rowIndex,
            blocking: !skip,
            kind: skip ? ImportWarningKind.IGNORED_ROW : outcome.kind,
          }),
        );
        continue;
      }
      if (outcome.value !== null) txns.push(outcome.value);
    }
    return importParseResult({ txns, warnings });
  }

  // --- rows --------------------------------------------------------------------------------------

  private records(
    text: string,
  ):
    | { readonly ok: true; readonly value: string[][] }
    | { readonly ok: false; readonly message: string } {
    const { delimiter, quote } = this.mapping;
    const parsed = readCsv(text, { delimiter, quotechar: quote, lines: "universal" });
    if (!parsed.ok) {
      return { ok: false, message: csvErrorMessage(parsed.reason, delimiter, quote) };
    }
    return { ok: true, value: parsed.rows };
  }

  private parseRow(row: Row, warnings: ImportWarning[]): RowOutcome<ParsedTxn | null> {
    const typeText = row.cell(CsvField.TYPE);
    const dateText = row.cell(CsvField.TRADE_DATE);
    if (typeText === null && dateText === null) {
      warnings.push(
        importWarning({
          message: "Row has no date and no type; skipped",
          row: row.index,
          kind: ImportWarningKind.IGNORED_ROW,
        }),
      );
      return ok(null);
    }
    if (typeText === null) return rowError("type is empty", ImportWarningKind.MISSING_VALUE);
    const typeKey = normalize(typeText);
    if (this.ignored.has(typeKey)) {
      warnings.push(
        importWarning({
          message: `Type "${typeText}" is ignored by the mapping`,
          row: row.index,
          kind: ImportWarningKind.IGNORED_ROW,
        }),
      );
      return ok(null);
    }
    const txnType = this.types.get(typeKey) ?? (isTxnType(typeKey) ? typeKey : null);
    if (txnType === null) {
      return rowError(
        `unknown type "${typeText}" (add it under types: in the mapping)`,
        ImportWarningKind.UNMAPPED_TYPE,
      );
    }

    const parsedDate = this.dateTime(row, CsvField.TRADE_DATE);
    if (!parsedDate.ok) return parsedDate;
    if (parsedDate.value === null) {
      return rowError("trade_date is empty", ImportWarningKind.MISSING_VALUE);
    }
    const tradeCurrency = currencyCell(row, CsvField.CURRENCY);
    if (!tradeCurrency.ok) return tradeCurrency;
    const currency = tradeCurrency.value ?? this.mapping.defaultCurrency;
    if (currency === null) {
      return rowError(
        "no currency in the row and no default_currency in the mapping",
        ImportWarningKind.MISSING_VALUE,
      );
    }
    const cashCurrencyCell = currencyCell(row, CsvField.CASH_CURRENCY);
    if (!cashCurrencyCell.ok) return cashCurrencyCell;
    const cashCurrency = cashCurrencyCell.value ?? currency;

    const numbers = new Map<CsvField, Decimal | null>();
    for (const target of [
      CsvField.QUANTITY,
      CsvField.PRICE,
      CsvField.FEE,
      CsvField.TAX,
      CsvField.FX_RATE,
      CsvField.CASH_AMOUNT,
    ]) {
      const value = this.number(row, target);
      if (!value.ok) return value;
      numbers.set(target, value.value);
    }
    const quantity = abs(numbers.get(CsvField.QUANTITY));
    const price = abs(numbers.get(CsvField.PRICE));
    const fee = nonZeroOrZero(abs(numbers.get(CsvField.FEE)));
    const tax = nonZeroOrZero(abs(numbers.get(CsvField.TAX)));
    const fxRate = abs(numbers.get(CsvField.FX_RATE));
    const rawCash = numbers.get(CsvField.CASH_AMOUNT) ?? null;
    let cash: Decimal | null = null;
    if (rawCash !== null) {
      const signed = signedCash(txnType, rawCash, this.mapping.amountSign === AmountSign.ABSOLUTE);
      if (!signed.ok) return rowError(signed.message, signed.kind);
      cash = signed.value;
    }
    const gross = this.number(row, CsvField.GROSS_AMOUNT);
    if (!gross.ok) return gross;
    const amounts = deriveAmounts({
      txnType,
      currency,
      cashCurrency,
      gross: gross.value,
      cash,
      quantity,
      price,
      fee,
      tax,
      fxRate,
    });
    if (!amounts.ok) return rowError(amounts.message, amounts.kind);

    let isin = row.cell(CsvField.ISIN);
    if (isin !== null) {
      isin = pyUpper(isin);
      if (!ISIN_PATTERN.test(isin)) {
        warnings.push(
          importWarning({
            message: `Ignored invalid ISIN "${isin}"`,
            row: row.index,
            kind: ImportWarningKind.INVALID_VALUE,
          }),
        );
        isin = null;
      }
    }

    const settle = this.dateTime(row, CsvField.SETTLE_DATE);
    if (!settle.ok) return settle;
    const splitRatio = this.number(row, CsvField.SPLIT_RATIO);
    if (!splitRatio.ok) return splitRatio;
    return ok(
      parsedTxn({
        rowIndex: row.index,
        externalRef: row.cell(CsvField.EXTERNAL_REF),
        tradeDate: parsedDate.value.date,
        tradeTime: parsedDate.value.time,
        settleDate: settle.value === null ? null : settle.value.date,
        type: txnType,
        symbol: row.cell(CsvField.SYMBOL),
        isin,
        name: row.cell(CsvField.NAME),
        exchangeHint: row.cell(CsvField.EXCHANGE),
        quantity,
        price,
        currency,
        grossAmount: amounts.value.grossAmount,
        fee,
        tax,
        cashAmount: amounts.value.cashAmount,
        cashCurrency,
        fxRate,
        splitRatio: abs(splitRatio.value),
        note: row.cell(CsvField.NOTE),
        rawRow: row.raw,
      }),
    );
  }

  private number(row: Row, target: CsvField): RowOutcome<Decimal | null> {
    const text = row.cell(target);
    if (text === null) return ok(null);
    const format = this.mapping.numberFormat;
    const parsed = parseDecimal(format, text);
    if (!parsed.ok) {
      return rowError(
        `${target}: "${text}" is not a number (decimal "${format.decimalSeparator}", thousands "${format.thousandsSeparator}")`,
      );
    }
    return ok(parsed.value);
  }

  private dateTime(row: Row, target: CsvField): RowOutcome<DatedTime | null> {
    const text = row.cell(target);
    if (text === null) return ok(null);
    const parsed = parseDatetimeWithPatterns(text, this.datePatterns);
    return parsed.ok ? ok(parsed.value) : rowError(`${target}: "${text}" - ${parsed.message}`);
  }
}

function currencyCell(row: Row, target: CsvField): RowOutcome<Currency | null> {
  const text = row.cell(target);
  if (text === null) return ok(null);
  const currency = tryCurrency(text);
  return currency === null
    ? rowError(`${target}: "${text}" is not an ISO 4217 currency code`)
    : ok(currency);
}

class Row {
  constructor(
    readonly index: number,
    private readonly cells: readonly string[],
    private readonly columns: ReadonlyMap<CsvField, number>,
    readonly raw: ReadonlyMap<string, string>,
  ) {}

  /** Trimmed cell of `target`, or null when unmapped, missing or blank. */
  cell(target: CsvField): string | null {
    const position = this.columns.get(target);
    if (position === undefined) return null;
    const value = pyStrip(this.cells[position] ?? "");
    return value || null;
  }
}

function blocked(message: string, kind: string = ImportWarningKind.FILE_FORMAT): ImportParseResult {
  return importParseResult({ warnings: [blockingWarning(null, message, kind)] });
}

function abs(value: Decimal | null | undefined): Decimal | null {
  return value == null ? null : value.copyAbs();
}

/** Python `value or Decimal(0)`: a zero (any exponent) becomes plain `0`. */
function nonZeroOrZero(value: Decimal | null): Decimal {
  return value === null || value.isZero() ? ZERO : value;
}

function normalize(value: string): string {
  return pyLower(pyStrip(value.replaceAll("\uFEFF", "")));
}

function headerIndex(header: readonly string[], name: string): number {
  const wanted = normalize(name);
  return header.findIndex((cell) => normalize(cell) === wanted);
}
