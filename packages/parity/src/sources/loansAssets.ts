/**
 * Typed readers of the loans and assets modules' tables, part of the read-only source
 * (`db.loansAssets`).
 *
 * Profile data is scoped through the profile's accounts (removed ones included: the Python queries
 * join `accounts.profile_id`, and the module code drops removed accounts itself). Rows come in id
 * order (the order SQLite returns the Python queries' rows in). Decimals stay the stored text
 * (`DecimalText`), timestamps the stored naive-UTC text.
 */

import { int, type Row, text, textOrNull } from "./decode.ts";

type Param = string | number | bigint | null;
type Query = (sql: string, ...params: Param[]) => Row[];

const PROFILE_ACCOUNTS = "SELECT id FROM accounts WHERE profile_id = ?";

/** `loans` (`modules/loans/models.py:Loan`). */
export interface LoanRow {
  readonly id: number;
  readonly accountId: number;
  readonly principal: string;
  /** Percent, e.g. `6.27`. */
  readonly annualRate: string;
  readonly termMonths: number;
  readonly startDate: string;
  readonly originationDate: string | null;
  readonly createdAt: string;
  /** When the terms were last set: balances recorded up to it are superseded. */
  readonly updatedAt: string;
  readonly paymentIban: string | null;
  readonly paymentText: string | null;
}

/** `depreciations` (`modules/assets/models.py:Depreciation`). */
export interface DepreciationRow {
  readonly id: number;
  readonly accountId: number;
  readonly purchasePrice: string;
  readonly purchaseDate: string;
  /** Percent, e.g. `15`. */
  readonly annualRate: string;
  readonly floor: string | null;
}

/** `asset_details` (`modules/assets/models.py:AssetDetails`). */
export interface AssetDetailRow {
  readonly id: number;
  readonly accountId: number;
  readonly note: string | null;
}

/** A balance snapshot with the moment it was recorded (`balances.created_at`, the loans anchor rule). */
export interface RecordedBalanceRow {
  readonly id: number;
  readonly accountId: number;
  readonly date: string;
  readonly amount: string;
  readonly createdAt: string;
}

export class LoansAssetsReader {
  private readonly query: Query;

  constructor(query: Query) {
    this.query = query;
  }

  /** The loans of the profile's accounts, in id order. */
  loans(profileId: number): LoanRow[] {
    return this.query(
      `SELECT id, account_id, principal, annual_rate, term_months, start_date, origination_date,
              created_at, updated_at, payment_iban, payment_text
       FROM loans WHERE account_id IN (${PROFILE_ACCOUNTS}) ORDER BY id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      principal: text(r, "principal"),
      annualRate: text(r, "annual_rate"),
      termMonths: int(r, "term_months"),
      startDate: text(r, "start_date"),
      originationDate: textOrNull(r, "origination_date"),
      createdAt: text(r, "created_at"),
      updatedAt: text(r, "updated_at"),
      paymentIban: textOrNull(r, "payment_iban"),
      paymentText: textOrNull(r, "payment_text"),
    }));
  }

  /** The depreciation curves of the profile's accounts, in id order. */
  depreciations(profileId: number): DepreciationRow[] {
    return this.query(
      `SELECT id, account_id, purchase_price, purchase_date, annual_rate, floor
       FROM depreciations WHERE account_id IN (${PROFILE_ACCOUNTS}) ORDER BY id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      purchasePrice: text(r, "purchase_price"),
      purchaseDate: text(r, "purchase_date"),
      annualRate: text(r, "annual_rate"),
      floor: textOrNull(r, "floor"),
    }));
  }

  /** The notes of the profile's positions, in id order. */
  assetDetails(profileId: number): AssetDetailRow[] {
    return this.query(
      `SELECT id, account_id, note FROM asset_details
       WHERE account_id IN (${PROFILE_ACCOUNTS}) ORDER BY id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      note: textOrNull(r, "note"),
    }));
  }

  /**
   * Balance snapshots of the profile's loan accounts with `created_at` (what `loan_valuation` reads per
   * loan), ordered by account id, then id.
   */
  loanAccountBalances(profileId: number): RecordedBalanceRow[] {
    return this.query(
      `SELECT id, account_id, date, amount, created_at FROM balances
       WHERE account_id IN (SELECT account_id FROM loans WHERE account_id IN (${PROFILE_ACCOUNTS}))
       ORDER BY account_id, id`,
      profileId,
    ).map((r) => ({
      id: int(r, "id"),
      accountId: int(r, "account_id"),
      date: text(r, "date"),
      amount: text(r, "amount"),
      createdAt: text(r, "created_at"),
    }));
  }
}
