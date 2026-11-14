/** Account events: trades, cash flows, corporate actions (`investments/domain/transaction.py`). */

import { type DateTime, toStorage } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { TxnSource, type TxnType } from "./enums.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  comparePyStr,
  EPOCH,
  type ImportBatchId,
  type Init,
  type InstrumentId,
  InvariantError,
  type TxnId,
  withDefaults,
} from "./values.js";

/**
 * One account event.
 *
 * Sign conventions: `quantity` and `grossAmount` are never negative, the direction comes from `type`.
 * `cashAmount` is the signed net effect on the account's cash in `cashCurrency` (a buy is negative, a
 * sell or dividend positive) and is the only field cash balances are computed from.
 *
 * Ordering: positions are derived in `compareChronological` order (trade date, `createdAt`, id).
 * Importers give the rows of one file strictly increasing `createdAt` values in chronological order.
 */
export interface Transaction {
  readonly id: TxnId;
  readonly accountId: AccountId;
  readonly type: TxnType;
  readonly tradeDate: CalendarDate;
  /** Currency of `price`, `grossAmount`, `fee` and `tax`. */
  readonly currency: Currency;
  /** Absolute value of the event before fees and taxes (quantity * price for trades), >= 0. */
  readonly grossAmount: Decimal;
  readonly cashAmount: Decimal;
  readonly cashCurrency: Currency;
  /** Null for pure cash events (deposit, withdrawal, account fee, interest). */
  readonly instrumentId: InstrumentId | null;
  readonly settleDate: CalendarDate | null;
  readonly quantity: Decimal | null;
  readonly price: Decimal | null;
  readonly fee: Decimal;
  readonly tax: Decimal;
  /** Units of `cashCurrency` per 1 unit of `currency` when they differ (broker conversion rate). */
  readonly fxRate: Decimal | null;
  /** For `SPLIT`: new units per old unit (a 1:4 split is 4). */
  readonly splitRatio: Decimal | null;
  readonly note: string | null;
  readonly source: TxnSource;
  readonly importBatchId: ImportBatchId | null;
  readonly externalRef: string | null;
  readonly dedupHash: string;
  readonly createdAt: DateTime;
}

export type TransactionInit = Init<
  Transaction,
  | "instrumentId"
  | "settleDate"
  | "quantity"
  | "price"
  | "fee"
  | "tax"
  | "fxRate"
  | "splitRatio"
  | "note"
  | "source"
  | "importBatchId"
  | "externalRef"
  | "dedupHash"
  | "createdAt"
>;

/** `Transaction(...)`: Python defaults; throws `InvariantError` for a negative quantity or gross amount. */
export function transaction(init: TransactionInit): Transaction {
  if (init.quantity?.lt(ZERO)) {
    throw new InvariantError(`quantity must be >= 0 (transaction ${init.id})`);
  }
  if (init.grossAmount.lt(ZERO)) {
    throw new InvariantError(`gross_amount must be >= 0 (transaction ${init.id})`);
  }
  return withDefaults<Transaction>(
    {
      instrumentId: null,
      settleDate: null,
      quantity: null,
      price: null,
      fee: ZERO,
      tax: ZERO,
      fxRate: null,
      splitRatio: null,
      note: null,
      source: TxnSource.IMPORT,
      importBatchId: null,
      externalRef: null,
      dedupHash: "",
      createdAt: EPOCH,
    },
    init,
  );
}

/**
 * `chronological_key`: the canonical processing order key (trade date, `createdAt` as naive UTC text,
 * id). A naive `createdAt` is read as UTC, so naive and aware timestamps can be mixed. Compare keys
 * with `compareChronological`, not with JS string order of the id.
 */
export function chronologicalKey(txn: Transaction): readonly [CalendarDate, string, TxnId] {
  return [txn.tradeDate, toStorage(txn.createdAt), txn.id];
}

/** Comparator for `sort`: trade date, then `createdAt` (by instant), then id (Python str order). */
export function compareChronological(a: Transaction, b: Transaction): number {
  const [dateA, createdA, idA] = chronologicalKey(a);
  const [dateB, createdB, idB] = chronologicalKey(b);
  if (dateA !== dateB) return dateA < dateB ? -1 : 1;
  if (createdA !== createdB) return createdA < createdB ? -1 : 1;
  return comparePyStr(idA, idB);
}
