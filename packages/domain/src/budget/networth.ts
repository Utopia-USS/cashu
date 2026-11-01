/**
 * Budget's net-worth contributor (`modules/budget/networth.py`, `CashContributor`): a cash pool account
 * is worth the running sum of its transactions, never a balance snapshot.
 */

import {
  type NetWorthAccount,
  type NetWorthContributor,
  RunningValuation,
  type Valuation,
  ZERO_00,
} from "../core/index.js";
import type { IsoDate } from "../dates.js";
import type { Decimal } from "../decimal.js";
import { CASH_ACCOUNT_TYPE } from "./cash.js";

/** One transaction as the pool valuation reads it. */
export interface CashPoolTxn {
  /** The account id in the caller's id space (the same space as the `NetWorthAccount` ids). */
  readonly account: string;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
}

/**
 * The contributor over the profile's transactions (any account; rows of other accounts are ignored).
 * `txns` MUST be in anchor order (Python's id order): PARITY(Q13) each pool's rows are sorted stably by
 * booking date, so input order breaks ties like Python's `(booking_date, id)`; the running sum starts at
 * `Decimal("0.00")` and the last value of each date is the point. Every cash account gets a valuation,
 * an empty one when it has no rows.
 */
export function cashContributor(txns: readonly CashPoolTxn[]): NetWorthContributor {
  const byAccount = new Map<string, CashPoolTxn[]>();
  for (const t of txns) {
    const list = byAccount.get(t.account);
    if (list === undefined) byAccount.set(t.account, [t]);
    else list.push(t);
  }
  return {
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      const out = new Map<string, Valuation>();
      for (const account of accounts.values()) {
        if (account.type !== CASH_ACCOUNT_TYPE) continue;
        const rows = [...(byAccount.get(account.id) ?? [])].sort((a, b) =>
          a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
        );
        const byDate = new Map<IsoDate, Decimal>();
        let run = ZERO_00;
        for (const t of rows) {
          run = run.add(t.amount);
          byDate.set(t.bookingDate, run);
        }
        out.set(account.id, new RunningValuation([...byDate.entries()]));
      }
      return out;
    },
  };
}
