/**
 * Gross / cash amount derivation shared by importers, including the cross-currency rule (R5).
 *
 * Sign conventions are those of `Transaction`: `grossAmount` >= 0, `cashAmount` signed in
 * `cashCurrency`, `fxRate` = units of `cashCurrency` per 1 unit of the trade `currency`.
 *
 * R5: when the cash amount has to be derived from the gross amount (or the reverse) and the cash
 * currency differs from the trade currency, `fxRate` converts; without a rate the row is rejected
 * (an `AmountFailure`) instead of booking the trade amount as if it were in the cash currency.
 *
 * Arithmetic runs in the ambient decimal context like Python: `deriveAmounts` sets the exact context
 * itself, the other functions follow the caller's.
 */

import { type Decimal, ZERO } from "../../decimal.js";
import { type Currency, dividedBy, exactDecimals, TxnType } from "../domain/index.js";

/** Types that take money out of the account (negative cash amount). */
export const CASH_OUTFLOW_TYPES: ReadonlySet<TxnType> = new Set([
  TxnType.BUY,
  TxnType.WITHDRAWAL,
  TxnType.FEE,
  TxnType.TAX,
]);

/** Types that bring money into the account (positive cash amount). */
export const CASH_INFLOW_TYPES: ReadonlySet<TxnType> = new Set([
  TxnType.SELL,
  TxnType.DIVIDEND,
  TxnType.DEPOSIT,
  TxnType.INTEREST,
]);

/** Types without a cash effect unless the file says otherwise. */
export const CASH_NEUTRAL_TYPES: ReadonlySet<TxnType> = new Set([
  TxnType.SPLIT,
  TxnType.TRANSFER_IN,
  TxnType.TRANSFER_OUT,
  TxnType.ADJUSTMENT,
]);

/**
 * Amounts of a row are missing or inconsistent (a row error for the importer; Python's `AmountError`).
 * `kind` is the matching `ImportWarningKind` value: `fx_missing` for R5, else `amount`.
 */
export interface AmountFailure {
  readonly ok: false;
  readonly message: string;
  readonly kind: "amount" | "fx_missing";
}

export type AmountOutcome<T> = { readonly ok: true; readonly value: T } | AmountFailure;

const ok = <T>(value: T): AmountOutcome<T> => ({ ok: true, value });
const failure = (message: string, kind: AmountFailure["kind"] = "amount"): AmountFailure => ({
  ok: false,
  message,
  kind,
});

/**
 * `value` with its direction: as written when not `absolute`, else from `txnType`. An absolute
 * `fx_conversion` amount fails (its direction is unknown).
 */
export function signedCash(
  txnType: TxnType,
  value: Decimal,
  absolute: boolean,
): AmountOutcome<Decimal> {
  if (!absolute) return ok(value);
  if (CASH_OUTFLOW_TYPES.has(txnType)) return ok(value.copyAbs().copyNegate());
  if (CASH_INFLOW_TYPES.has(txnType)) return ok(value.copyAbs());
  if (txnType === TxnType.FX_CONVERSION) {
    return failure("fx_conversion rows need signed amounts (the direction cannot be derived)");
  }
  return ok(value);
}

/**
 * Gross amount implied by a net cash amount in the trade currency: inflows add fee and tax back,
 * outflows remove them.
 */
export function grossFromCash(
  txnType: TxnType,
  cash: Decimal,
  fee: Decimal,
  tax: Decimal,
): AmountOutcome<Decimal> {
  const magnitude = cash.abs();
  let gross: Decimal;
  if (CASH_INFLOW_TYPES.has(txnType)) gross = magnitude.add(fee).add(tax);
  else if (CASH_OUTFLOW_TYPES.has(txnType)) gross = magnitude.sub(fee).sub(tax);
  else gross = magnitude;
  if (gross.lt(ZERO)) return failure("fee and tax exceed the cash amount");
  return ok(gross);
}

/** Net cash effect (trade currency) implied by a gross amount when the row has no cash amount. */
export function cashFromGross(
  txnType: TxnType,
  gross: Decimal,
  fee: Decimal,
  tax: Decimal,
): AmountOutcome<Decimal> {
  if (CASH_INFLOW_TYPES.has(txnType)) return ok(gross.sub(fee).sub(tax));
  if (CASH_OUTFLOW_TYPES.has(txnType)) return ok(gross.add(fee).add(tax).neg());
  if (CASH_NEUTRAL_TYPES.has(txnType)) return ok(ZERO);
  return failure(`${txnType} rows need a cash_amount value`);
}

/** `amount` (trade `currency`) in `cashCurrency` via `fxRate` (R5). */
export function toCashCurrency(
  amount: Decimal,
  currency: Currency,
  cashCurrency: Currency,
  fxRate: Decimal | null,
): AmountOutcome<Decimal> {
  if (cashCurrency === currency || amount.isZero()) return ok(amount);
  if (fxRate === null || fxRate.isZero()) {
    return failure(
      `cash_amount is empty and cash_currency ${cashCurrency} differs from currency ${currency}: fx_rate (or cash_amount) is needed to derive the cash effect`,
      "fx_missing",
    );
  }
  return ok(amount.mul(fxRate));
}

/** `amount` (`cashCurrency`) in the trade `currency` via `fxRate` (R5, reverse). */
export function toTradeCurrency(
  amount: Decimal,
  currency: Currency,
  cashCurrency: Currency,
  fxRate: Decimal | null,
): AmountOutcome<Decimal> {
  if (cashCurrency === currency || amount.isZero()) return ok(amount);
  if (fxRate === null || fxRate.isZero()) {
    return failure(
      `gross_amount is empty and cash_currency ${cashCurrency} differs from currency ${currency}: fx_rate (or gross_amount, or quantity and price) is needed to derive the gross amount`,
      "fx_missing",
    );
  }
  return ok(dividedBy(amount, fxRate));
}

export interface DerivedAmounts {
  /** >= 0, trade currency. */
  readonly grossAmount: Decimal;
  /** Signed, cash currency. */
  readonly cashAmount: Decimal;
}

export interface DeriveInput {
  readonly txnType: TxnType;
  readonly currency: Currency;
  readonly cashCurrency: Currency;
  readonly gross?: Decimal | null;
  readonly cash?: Decimal | null;
  readonly quantity?: Decimal | null;
  readonly price?: Decimal | null;
  readonly fee?: Decimal;
  readonly tax?: Decimal;
  readonly fxRate?: Decimal | null;
}

/**
 * Fill in the gross and cash amounts of a row from whatever it has.
 *
 * Gross: the given gross (absolute), else `quantity * price`, else derived from the cash amount
 * (converted to the trade currency, fee and tax added back / removed), else 0 for rows with only a fee
 * or tax or a cash-neutral type. Cash: the given (already signed) cash, else derived from the gross
 * amount and converted to the cash currency. Fails when neither is possible.
 */
export function deriveAmounts(input: DeriveInput): AmountOutcome<DerivedAmounts> {
  return exactDecimals(() => {
    const { txnType, currency, cashCurrency } = input;
    const fee = (input.fee ?? ZERO).abs();
    const tax = (input.tax ?? ZERO).abs();
    const fxRate = input.fxRate ?? null;
    let cash = input.cash ?? null;
    let grossAmount: Decimal;
    if (input.gross != null) {
      grossAmount = input.gross.abs();
    } else if (input.quantity != null && input.price != null) {
      grossAmount = input.quantity.abs().mul(input.price.abs());
    } else if (cash !== null) {
      const inTradeCurrency = toTradeCurrency(cash, currency, cashCurrency, fxRate);
      if (!inTradeCurrency.ok) return inTradeCurrency;
      const gross = grossFromCash(txnType, inTradeCurrency.value, fee, tax);
      if (!gross.ok) return gross;
      grossAmount = gross.value;
    } else if (fee.add(tax).gt(ZERO) || CASH_NEUTRAL_TYPES.has(txnType)) {
      grossAmount = ZERO;
    } else {
      return failure("no amount (gross_amount, cash_amount, or quantity and price)");
    }
    if (cash === null) {
      const implied = cashFromGross(txnType, grossAmount, fee, tax);
      if (!implied.ok) return implied;
      const converted = toCashCurrency(implied.value, currency, cashCurrency, fxRate);
      if (!converted.ok) return converted;
      cash = converted.value;
    }
    return ok({ grossAmount, cashAmount: cash });
  });
}
