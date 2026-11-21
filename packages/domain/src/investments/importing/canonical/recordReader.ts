/**
 * Reads one canonical record's fields with strict checks, collecting every problem (never throws).
 * Shared by the CSV and the JSON variant (`_RecordReader` of the Python importer).
 */

import { checkYmd, formatDate, PyValueError } from "../../../dates.js";
import { Decimal, ZERO } from "../../../decimal.js";
import { pyLen, pyLower } from "../../../text.js";
import {
  type Currency,
  exactDecimals,
  InvariantError,
  TxnType,
  toCurrency,
} from "../../domain/index.js";
import {
  CASH_INFLOW_TYPES,
  CASH_NEUTRAL_TYPES,
  CASH_OUTFLOW_TYPES,
  cashFromGross,
  deriveAmounts,
} from "../cash.js";
import {
  blockingWarning,
  type ImportWarning,
  ImportWarningKind,
  importWarning,
  type ParsedCorporateAction,
  type ParsedPosition,
  type ParsedTxn,
  parsedDelisting,
  parsedPosition,
  parsedRename,
  parsedTxn,
  type TimeOfDay,
} from "../contract.js";
import { didYouMean } from "../didYouMean.js";
import {
  CASH_NOT_NEGATIVE_ERROR,
  CASH_NOT_NEGATIVE_WARNING,
  CASH_NOT_POSITIVE_ERROR,
  CASH_NOT_POSITIVE_WARNING,
  CONSISTENCY_TOLERANCE,
  CURRENCY_RE,
  DATE_RE,
  INSTRUMENT_FORBIDDEN,
  INSTRUMENT_REQUIRED,
  ISIN_RE,
  MAX_NAME,
  MAX_NOTE,
  MAX_REF,
  MAX_SYMBOL,
  NUMBER_RE,
  QUANTITY_FORBIDDEN,
  QUANTITY_REQUIRED,
  RECORD_FIELDS,
  RECORD_KINDS,
  RecordKind,
  TIME_RE,
} from "./constants.js";

/** Largest exponent of a number the importer calculates with (`decimal.MAX_EMAX` of the exact context). */
const MAX_EXPONENT = 999_999;

/** A raw field value: CSV cells are text, JSON values keep their JSON type (numbers as `Decimal`). */
export type Value = string | Decimal | boolean | null;

/** What a record turned into. */
export type ParsedRecord =
  | { readonly record: "txn"; readonly txn: ParsedTxn }
  | { readonly record: "position"; readonly position: ParsedPosition }
  | { readonly record: "action"; readonly action: ParsedCorporateAction };

/** `_raw_text`: the text of a raw value for messages (a decimal in plain notation). */
export function rawText(value: Value): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value;
  try {
    return value.format("f");
  } catch {
    return value.toString();
  }
}

export class RecordReader {
  /** Every problem found so far, in the order found. */
  readonly issues: ImportWarning[] = [];
  private errors = 0;
  private readonly row: number;
  private readonly values: ReadonlyMap<string, Value>;

  constructor(row: number, values: ReadonlyMap<string, Value>) {
    this.row = row;
    this.values = values;
  }

  // --- issue helpers ---

  /** A blocking problem; without `kind`, "is required..." is `missing_value`, else `invalid_value`. */
  private error(name: string, message: string, kind?: string): void {
    this.errors += 1;
    const resolved =
      kind ??
      (message.startsWith("is required")
        ? ImportWarningKind.MISSING_VALUE
        : ImportWarningKind.INVALID_VALUE);
    this.issues.push(blockingWarning(this.row, `${name}: ${message}`, resolved));
  }

  private warn(name: string, message: string, kind: string): void {
    this.issues.push(importWarning({ message: `${name}: ${message}`, row: this.row, kind }));
  }

  // --- typed field access (null when empty or invalid; invalid values record an error) ---

  private raw(name: string): Value {
    return this.values.get(name) ?? null;
  }

  private text(name: string, maxLength: number = MAX_NAME): string | null {
    const value = this.raw(name);
    if (value === null) return null;
    if (typeof value !== "string") {
      this.error(name, "must be text (in JSON a quoted string)");
      return null;
    }
    if (pyLen(value) > maxLength) {
      this.error(name, `longer than ${maxLength} characters`);
      return null;
    }
    return value;
  }

  private requiredText(name: string, maxLength: number = MAX_NAME): string | null {
    if (this.raw(name) === null) {
      this.error(name, "is required");
      return null;
    }
    return this.text(name, maxLength);
  }

  private date(name: string, required = false): string | null {
    const text = this.text(name);
    if (text === null) {
      if (required && this.raw(name) === null) this.error(name, "is required (YYYY-MM-DD)");
      return null;
    }
    const match = DATE_RE.exec(text);
    if (match === null) {
      this.error(name, `"${text}" is not a date in YYYY-MM-DD format`);
      return null;
    }
    try {
      return formatDate(checkYmd(Number(match[1]), Number(match[2]), Number(match[3])));
    } catch (error) {
      if (!(error instanceof PyValueError)) throw error;
      this.error(name, `"${text}" is not a real calendar date`);
      return null;
    }
  }

  private time(name: string): TimeOfDay | null {
    const text = this.text(name);
    if (text === null) return null;
    const match = TIME_RE.exec(text);
    if (match === null) {
      this.error(name, `"${text}" is not a time in HH:MM or HH:MM:SS format`);
      return null;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const second = Number(match[3] ?? 0);
    if (hour > 23 || minute > 59 || second > 59) {
      this.error(name, `"${text}" is not a valid time of day`);
      return null;
    }
    return { hour, minute, second };
  }

  private decimal(
    name: string,
    options: { minimum?: Decimal; positive?: boolean; required?: boolean } = {},
  ): Decimal | null {
    const value = this.raw(name);
    if (value === null) {
      if (options.required) this.error(name, "is required");
      return null;
    }
    let number: Decimal | null;
    if (typeof value === "boolean") number = null;
    else if (typeof value === "string")
      number = NUMBER_RE.test(value) ? Decimal.parse(value) : null;
    else number = value;
    if (number === null) {
      this.error(
        name,
        `"${rawText(value)}" is not a decimal number (use "." as decimal separator, no thousands separators)`,
      );
      return null;
    }
    if (Math.abs(number.adjusted()) > MAX_EXPONENT) {
      // PARITY(S17a): Python formats such a value in plain notation (up to 10^12 digits) and raises
      // decimal.Overflow in the exact context; here it is a row error. Report the same way in Python.
      this.error(
        name,
        `${number} is out of range (the exponent must stay within +-${MAX_EXPONENT})`,
      );
      return null;
    }
    if (options.positive && number.lte(ZERO)) {
      this.error(name, "must be greater than 0");
      return null;
    }
    if (options.minimum !== undefined && number.lt(options.minimum)) {
      this.error(name, `must not be negative (got ${rawText(value)})`);
      return null;
    }
    return number;
  }

  private currency(name: string, required = false): Currency | null {
    const text = this.text(name);
    if (text === null) {
      if (required && this.raw(name) === null) {
        this.error(name, "is required (ISO 4217 code, e.g. PLN)");
      }
      return null;
    }
    if (!CURRENCY_RE.test(text)) {
      this.error(name, `"${text}" is not an upper-case ISO 4217 code (e.g. PLN, USD)`);
      return null;
    }
    return toCurrency(text);
  }

  private isin(name: string): string | null {
    const text = this.text(name, 12);
    if (text === null) return null;
    if (!ISIN_RE.test(text)) {
      this.error(name, `"${text}" is not an ISIN (12 upper-case characters, e.g. IE00B4L5Y983)`);
      return null;
    }
    return text;
  }

  private boolean(name: string): boolean {
    const value = this.raw(name);
    if (value === null) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const lower = pyLower(value);
      if (lower === "true" || lower === "false") return lower === "true";
    }
    this.error(name, `"${rawText(value)}" is not true or false`);
    return false;
  }

  // --- records ---

  /** The record as parsed, or null when it has any error (a row with an error is not emitted). */
  read(raw: ReadonlyMap<string, string>): ParsedRecord | null {
    for (const name of this.values.keys()) {
      if (!RECORD_FIELDS.has(name)) {
        this.error(
          name,
          `unknown field${didYouMean(name, RECORD_FIELDS.keys())}`,
          ImportWarningKind.UNKNOWN_FIELD,
        );
      }
    }
    const kindText = this.text("record");
    if (kindText === null) {
      if (this.raw("record") === null) {
        this.error("record", "is required (txn, position, rename or delisting)");
      }
      return null;
    }
    const kind = RECORD_KINDS.find((candidate) => candidate === kindText);
    if (kind === undefined) {
      this.error(
        "record",
        `"${kindText}" is not a record kind (txn, position, rename, delisting)${didYouMean(kindText, RECORD_KINDS)}`,
      );
      return null;
    }
    for (const [name, value] of this.values) {
      const allowed = RECORD_FIELDS.get(name);
      if (allowed !== undefined && value !== null && !allowed.has(kind)) {
        this.error(name, `not allowed in a ${kind} record`, ImportWarningKind.UNKNOWN_FIELD);
      }
    }
    let parsed: ParsedRecord | null;
    switch (kind) {
      case RecordKind.TXN: {
        const txn = this.txn(raw);
        parsed = txn === null ? null : { record: "txn", txn };
        break;
      }
      case RecordKind.POSITION: {
        const position = this.position();
        parsed = position === null ? null : { record: "position", position };
        break;
      }
      case RecordKind.RENAME: {
        const action = this.rename();
        parsed = action === null ? null : { record: "action", action };
        break;
      }
      case RecordKind.DELISTING: {
        const action = this.delisting();
        parsed = action === null ? null : { record: "action", action };
        break;
      }
    }
    return this.errors > 0 ? null : parsed;
  }

  private txn(raw: ReadonlyMap<string, string>): ParsedTxn | null {
    const tradeDate = this.date("date", true);
    const tradeTime = this.time("time");
    const settleDate = this.date("settle_date");
    const typeText = this.text("type");
    let txnType: TxnType | null = null;
    if (typeText === null) {
      if (this.raw("type") === null) this.error("type", "is required");
    } else {
      const found = Object.values(TxnType).find((candidate) => candidate === typeText);
      if (found === undefined) {
        this.error(
          "type",
          `"${typeText}" is not a transaction type${didYouMean(typeText, Object.values(TxnType))}`,
          ImportWarningKind.UNMAPPED_TYPE,
        );
      } else {
        txnType = found;
      }
    }
    const externalRef = this.text("external_ref", MAX_REF);
    const symbol = this.text("symbol", MAX_SYMBOL);
    const isin = this.isin("isin");
    const name = this.text("name");
    const exchange = this.text("exchange", MAX_SYMBOL);
    const quantity = this.decimal("quantity", { minimum: ZERO });
    const price = this.decimal("price", { minimum: ZERO });
    const currency = this.currency("currency", true);
    const gross = this.decimal("gross_amount", { minimum: ZERO });
    // Python `x or zero`: a zero fee / tax is replaced by the plain zero.
    const fee = nonZeroOrZero(this.decimal("fee", { minimum: ZERO }));
    const tax = nonZeroOrZero(this.decimal("tax", { minimum: ZERO }));
    const cash = this.decimal("cash_amount");
    const cashCurrency = this.currency("cash_currency");
    const fxRate = this.decimal("fx_rate", { positive: true });
    const splitRatio = this.decimal("split_ratio", { positive: true });
    const note = this.text("note", MAX_NOTE);
    if (txnType === null || tradeDate === null || currency === null) return null;

    // Raw presence, so an invalid ISIN reports one problem, not also "needs an instrument".
    const hasInstrument = ["symbol", "isin", "name"].some((field) => this.raw(field) !== null);
    if (INSTRUMENT_REQUIRED.has(txnType) && !hasInstrument) {
      this.error(
        "symbol",
        `${txnType} needs an instrument (symbol, isin or name)`,
        ImportWarningKind.MISSING_INSTRUMENT,
      );
    }
    if (INSTRUMENT_FORBIDDEN.has(txnType)) {
      for (const instrumentField of ["symbol", "isin", "name", "exchange"]) {
        if (this.raw(instrumentField) !== null) {
          this.error(
            instrumentField,
            `must be empty for ${txnType}`,
            ImportWarningKind.MISSING_INSTRUMENT,
          );
        }
      }
    }
    if (QUANTITY_REQUIRED.has(txnType)) {
      if (this.raw("quantity") === null) {
        this.error("quantity", `is required for ${txnType}`, ImportWarningKind.MISSING_QUANTITY);
      } else if (quantity?.isZero()) {
        this.error("quantity", "must be greater than 0", ImportWarningKind.MISSING_QUANTITY);
      }
    } else if (QUANTITY_FORBIDDEN.has(txnType) && this.raw("quantity") !== null) {
      this.error("quantity", `must be empty for ${txnType}`, ImportWarningKind.MISSING_QUANTITY);
    }
    if (txnType === TxnType.SPLIT) {
      if (this.raw("split_ratio") === null) {
        this.error("split_ratio", "is required for split", ImportWarningKind.UNKNOWN_SPLIT_RATIO);
      }
    } else if (this.raw("split_ratio") !== null) {
      this.error("split_ratio", "only allowed for split");
    }
    if (txnType === TxnType.FX_CONVERSION) {
      if (this.raw("cash_amount") === null) {
        this.error("cash_amount", "is required for fx_conversion (signed amount of the leg)");
      }
      if (cashCurrency !== null && cashCurrency !== currency) {
        this.error(
          "cash_currency",
          "each fx_conversion leg is booked in its own currency: leave it empty or equal to currency",
        );
      }
    }
    this.checkCashSign(txnType, cash);
    if (this.errors > 0) return null;

    const settleCurrency = cashCurrency ?? currency;
    const amounts = deriveAmounts({
      txnType,
      currency,
      cashCurrency: settleCurrency,
      gross,
      cash,
      quantity,
      price,
      fee,
      tax,
      fxRate,
    });
    if (!amounts.ok) {
      this.error(cash === null ? "cash_amount" : "gross_amount", amounts.message, amounts.kind);
      return null;
    }
    if (
      gross !== null &&
      cash !== null &&
      settleCurrency === currency &&
      (CASH_INFLOW_TYPES.has(txnType) || CASH_OUTFLOW_TYPES.has(txnType))
    ) {
      const { expected, difference } = exactDecimals(() => {
        const implied = cashFromGross(txnType, gross, fee, tax);
        if (!implied.ok) throw new InvariantError(implied.message);
        return { expected: implied.value, difference: cash.sub(implied.value).abs() };
      });
      if (difference.gt(CONSISTENCY_TOLERANCE)) {
        this.warn(
          "cash_amount",
          `${cash} does not match gross_amount ${gross}, fee ${fee} and tax ${tax} (expected ${expected}, difference ${difference})`,
          ImportWarningKind.AMOUNT_MISMATCH,
        );
      }
    }
    if (this.errors > 0) return null;
    return parsedTxn({
      rowIndex: this.row,
      tradeDate,
      type: txnType,
      currency,
      grossAmount: amounts.value.grossAmount,
      cashAmount: amounts.value.cashAmount,
      cashCurrency: settleCurrency,
      externalRef,
      tradeTime,
      settleDate,
      symbol,
      isin,
      name,
      exchangeHint: exchange,
      quantity,
      price,
      fee,
      tax,
      fxRate,
      splitRatio,
      note,
      rawRow: raw,
    });
  }

  /** Sign rules of section 4 of the spec (given cash amounts only, never derived ones). */
  private checkCashSign(txnType: TxnType, cash: Decimal | null): void {
    if (cash === null) return;
    if (cash.gt(ZERO) && CASH_NOT_POSITIVE_ERROR.has(txnType)) {
      this.error(
        "cash_amount",
        `${cash} must be <= 0 for ${txnType} (money leaves the account)`,
        ImportWarningKind.CASH_SIGN,
      );
    } else if (cash.lt(ZERO) && CASH_NOT_NEGATIVE_ERROR.has(txnType)) {
      this.error(
        "cash_amount",
        `${cash} must be >= 0 for ${txnType} (money comes in)`,
        ImportWarningKind.CASH_SIGN,
      );
    } else if (cash.gt(ZERO) && CASH_NOT_POSITIVE_WARNING.has(txnType)) {
      this.warn(
        "cash_amount",
        `${cash} is positive for ${txnType} (a refund?)`,
        ImportWarningKind.CASH_SIGN,
      );
    } else if (cash.lt(ZERO) && CASH_NOT_NEGATIVE_WARNING.has(txnType)) {
      this.warn(
        "cash_amount",
        `${cash} is negative for ${txnType} (a correction?)`,
        ImportWarningKind.CASH_SIGN,
      );
    } else if (!cash.isZero() && CASH_NEUTRAL_TYPES.has(txnType)) {
      this.warn(
        "cash_amount",
        `${txnType} usually has no cash effect (got ${cash})`,
        ImportWarningKind.CASH_SIGN,
      );
    }
  }

  private position(): ParsedPosition | null {
    const asOf = this.date("date", true);
    const symbol = this.text("symbol", MAX_SYMBOL);
    const isin = this.isin("isin");
    const name = this.text("name");
    const exchange = this.text("exchange", MAX_SYMBOL);
    const quantity = this.decimal("quantity", { minimum: ZERO, required: true });
    const currency = this.currency("currency", true);
    const avgPrice = this.decimal("avg_price", { minimum: ZERO });
    const marketValue = this.decimal("market_value", { minimum: ZERO });
    this.text("note", MAX_NOTE);
    if (["symbol", "isin", "name"].every((field) => this.raw(field) === null)) {
      this.error(
        "symbol",
        "a position needs an instrument (symbol, isin or name)",
        ImportWarningKind.MISSING_INSTRUMENT,
      );
    }
    if (asOf === null || quantity === null || currency === null) return null;
    return parsedPosition({
      quantity,
      currency,
      asOf,
      symbol,
      isin,
      name,
      exchangeHint: exchange,
      avgPrice,
      marketValue,
    });
  }

  private rename(): ParsedCorporateAction | null {
    const effective = this.date("date", true);
    const oldSymbol = this.requiredText("symbol", MAX_SYMBOL);
    const oldIsin = this.isin("isin");
    const exchange = this.text("exchange", MAX_SYMBOL);
    const newSymbol = this.requiredText("new_symbol", MAX_SYMBOL);
    const newIsin = this.isin("new_isin");
    const newExchange = this.text("new_exchange", MAX_SYMBOL);
    const newName = this.text("new_name");
    const note = this.text("note", MAX_NOTE);
    if (effective === null || oldSymbol === null || newSymbol === null) return null;
    if (
      oldSymbol === newSymbol &&
      (newIsin === null || newIsin === oldIsin) &&
      (newExchange === null || newExchange === exchange)
    ) {
      this.error("new_symbol", "a rename must change the symbol, ISIN or exchange");
      return null;
    }
    return parsedRename({
      date: effective,
      rowIndex: this.row,
      note,
      oldSymbol,
      newSymbol,
      oldIsin,
      newIsin,
      exchangeHint: exchange,
      newExchangeHint: newExchange,
      newName,
    });
  }

  private delisting(): ParsedCorporateAction | null {
    const effective = this.date("date", true);
    const symbol = this.requiredText("symbol", MAX_SYMBOL);
    const isin = this.isin("isin");
    const exchange = this.text("exchange", MAX_SYMBOL);
    const frozen = this.boolean("frozen");
    const note = this.text("note", MAX_NOTE);
    if (effective === null || symbol === null) return null;
    return parsedDelisting({
      date: effective,
      rowIndex: this.row,
      note,
      symbol,
      isin,
      exchangeHint: exchange,
      frozen,
    });
  }
}

function nonZeroOrZero(value: Decimal | null): Decimal {
  return value === null || value.isZero() ? ZERO : value;
}
