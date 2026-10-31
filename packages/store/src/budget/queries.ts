// Typed reads of the budget view tables the commands need (gid in, gid out).

import { D } from "@cashu/domain";
import type { StoredTxn } from "@cashu/domain/budget";
import type { Read } from "../core/queries.js";

/**
 * Every row of the (resolved) account in storage order, cash legs, cash expenses and `legacy:` rows
 * included: they never match a v2 hash but count for the newest-day rule (S07 `StoredTxn`).
 */
export function storedTxnsOfAccount(read: Read, account: string): StoredTxn[] {
  return read<{
    dedup_hash: string;
    bank_transaction_id: string | null;
    booking_date: string;
    amount: string;
  }>(
    `SELECT t.dedup_hash, t.bank_transaction_id, t.booking_date, t.amount
     FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.gid = ? ORDER BY t.id`,
    account,
  ).map((r) => ({
    dedupHash: r.dedup_hash,
    bankTransactionId: r.bank_transaction_id,
    bookingDate: r.booking_date,
    amount: D(r.amount),
  }));
}

export interface TxnView {
  readonly gid: string;
  readonly dedupHash: string;
  readonly accountType: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The transaction row `gid` (an import's anchor, a cash expense, a cash leg). */
export function transactionByGid(read: Read, gid: string): TxnView | undefined {
  const r = read<{ gid: string; dedup_hash: string; type: string | null; raw: string }>(
    `SELECT t.gid, t.dedup_hash, a.type, t.raw FROM transactions t
     LEFT JOIN accounts a ON a.id = t.account_id WHERE t.gid = ?`,
    gid,
  )[0];
  return r === undefined
    ? undefined
    : { gid: r.gid, dedupHash: r.dedup_hash, accountType: r.type, raw: JSON.parse(r.raw) };
}
