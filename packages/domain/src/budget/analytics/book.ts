/**
 * The loaded rows the budget analytics read (`modules/budget/analytics.py`, `monthclose.py`): one
 * profile's (vault's) accounts and transactions, as the store or a parity producer loads them. SQL
 * stays in the caller; every analytics function is pure over a `BudgetBook`.
 */

import { type NetWorthAccount, ownIbans } from "../../core/index.js";
import type { IsoDate } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import { ibanKey } from "../../iban.js";

/** An account of the profile (`NetWorthAccount` ids are the caller's id space). */
export interface BudgetAccount extends NetWorthAccount {
  readonly name: string;
  /** The raw stored account number (`own_ibans` keys it with `ibanKey`). */
  readonly iban: string | null;
}

/** One stored budget transaction (its category and transfer flag as stored, never recomputed). */
export interface BudgetTxn {
  /** Row identity in the caller's id space (store: gid; parity: the Python id). */
  readonly key: string;
  /** The account's `BudgetAccount.id`. */
  readonly account: string;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly counterpartyName: string | null;
  readonly counterpartyIban: string | null;
  readonly description: string | null;
  readonly reference: string | null;
  readonly bankTransactionId: string | null;
  readonly category: string | null;
  readonly categorySource: string | null;
  readonly isInternalTransfer: boolean;
  /** The matched transfer pair's group id, null when unmatched. */
  readonly transferGroup: string | null;
  /** For a cash leg: the key of the bank row it mirrors (Python `dedup_hash == "cashleg:<id>"`). */
  readonly cashLegOf: string | null;
}

/** One profile's budget rows. */
export interface BudgetBook {
  /** `analytics.base_currency`: the profile's base currency (see `budgetBaseCurrency`). */
  readonly baseCurrency: string;
  /** Every account of the profile in storage (id) order, removed ones included (Python reads all). */
  readonly accounts: readonly BudgetAccount[];
  /**
   * Every transaction of the profile's accounts in storage order: by account, then by row (Python's
   * SQLite plan walks `ix_transactions_account_id`). Only ties of equal sort keys depend on it.
   */
  readonly transactions: readonly BudgetTxn[];
}

/** `analytics.base_currency`: the stored base currency, "PLN" when it is empty or missing. */
export function budgetBaseCurrency(stored: string | null | undefined): string {
  return stored || "PLN";
}

/** `core.accounts.own_ibans` of the book (every account, removed ones too). */
export function bookOwnIbans(book: BudgetBook): Set<string> {
  return ownIbans(book.accounts);
}

/** Python `f"{year}-{month:02d}"`. */
export function monthLabel(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The year and month of an ISO date. */
export function yearMonth(d: IsoDate): readonly [number, number] {
  return [Number(d.slice(0, 4)), Number(d.slice(5, 7))];
}

/** `NON_SPENDING_CATEGORIES`: structural moves (internal transfers, withdrawals into the cash pool). */
export const NON_SPENDING_CATEGORIES: ReadonlySet<string> = new Set([
  "transfer",
  "cash_withdrawal",
]);

/** True when the counterparty account number is one of the profile's own (`iban_key` match). */
export function isOwnCounterparty(t: BudgetTxn, own: ReadonlySet<string>): boolean {
  const cp = t.counterpartyIban ? ibanKey(t.counterpartyIban) : "";
  return cp !== "" && own.has(cp);
}

/**
 * `monthclose._is_flow`: income or spending (the cashflow filters), false for a transfer: a structural
 * category, a matched internal transfer or an own-account counterparty.
 */
export function isFlow(t: BudgetTxn, own: ReadonlySet<string>): boolean {
  if ((t.category !== null && NON_SPENDING_CATEGORIES.has(t.category)) || t.isInternalTransfer) {
    return false;
  }
  return !isOwnCounterparty(t, own);
}

/** A period filter (`_in_period`): each given part must match; none given = every date. */
export interface Period {
  readonly year?: number | null;
  readonly month?: number | null;
  readonly quarter?: number | null;
}

/** `analytics._in_period`. */
export function inPeriod(d: IsoDate, period: Period): boolean {
  const [year, month] = yearMonth(d);
  if (period.year != null && year !== period.year) return false;
  if (period.month != null && month !== period.month) return false;
  return period.quarter == null || Math.floor((month - 1) / 3) + 1 === period.quarter;
}
