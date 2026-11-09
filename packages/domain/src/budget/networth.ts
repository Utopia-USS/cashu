/**
 * Budget's net-worth contributors: a cash pool account is worth the running sum of its transactions,
 * never a balance snapshot (`modules/budget/networth.py`, `CashContributor`); a bank account is worth
 * its balance snapshots, and before the first one the history walks back from it over the imported
 * transactions (`bankBalanceContributor`).
 */

import {
  type BalanceSnapshot,
  BalanceValuation,
  type LatestEntry,
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

/** The bank account types whose history walks back from the first balance (budget's own types). */
export const BANK_BALANCE_TYPES: ReadonlySet<string> = new Set(["checking", "savings", "credit"]);

/**
 * A bank account's balance snapshots, extended back over its transactions. An Open Banking import
 * stores one balance (today's) next to ~90 days of transactions, so the snapshots alone know nothing
 * before today; the end-of-day balance of an earlier day is the first snapshot minus every
 * transaction booked after that day up to the snapshot's day. Before the first transaction the
 * balance is the opening one: known when it is zero (the account started empty), unknown otherwise.
 * Net worth now (`latest`) is the snapshots' own value, unchanged.
 */
export class BackfilledBalanceValuation implements Valuation {
  private readonly snapshots: BalanceValuation;
  private readonly first: IsoDate | null;
  /** `[day, end-of-day balance]` of the transaction days before the first snapshot, ascending. */
  private readonly back: readonly LatestEntry[];
  /** The balance before the first transaction (or the first snapshot's when none is earlier). */
  private readonly opening: Decimal | null;

  constructor(balances: readonly BalanceSnapshot[], txns: readonly CashPoolTxn[]) {
    this.snapshots = new BalanceValuation(balances);
    this.first = this.snapshots.knownFrom();
    const anchor = this.first === null ? null : this.snapshots.at(this.first);
    const first = this.first;
    if (first === null || anchor === null) {
      this.back = [];
      this.opening = null;
      return;
    }
    const byDay = new Map<IsoDate, Decimal>();
    for (const t of txns) {
      if (t.bookingDate > first) continue;
      byDay.set(t.bookingDate, (byDay.get(t.bookingDate) ?? ZERO_00).add(t.amount));
    }
    const back: LatestEntry[] = [];
    let run = anchor;
    for (const day of [...byDay.keys()].sort().reverse()) {
      if (day < first) back.push([day, run]);
      run = run.sub(byDay.get(day) as Decimal);
    }
    this.back = back.reverse();
    this.opening = run;
  }

  latest(asOf: IsoDate | null, today: IsoDate): LatestEntry | null {
    return this.snapshots.latest(asOf, today);
  }

  at(d: IsoDate): Decimal | null {
    if (this.first === null) return null;
    if (d >= this.first) return this.snapshots.at(d);
    let last: Decimal | null = null;
    for (const [day, v] of this.back) {
      if (day <= d) last = v;
      else break;
    }
    if (last !== null) return last;
    return this.opening?.isZero() ? ZERO_00 : null;
  }

  axisDates(): IsoDate[] {
    return [...this.back.map(([d]) => d), ...this.snapshots.axisDates()];
  }

  knownFrom(): IsoDate | null {
    if (this.opening?.isZero()) return null;
    return this.back[0]?.[0] ?? this.first;
  }
}

/**
 * Bank accounts (`BANK_BALANCE_TYPES`) with at least one balance snapshot, valued by
 * `BackfilledBalanceValuation` over their own transactions. Accounts without a snapshot are left out
 * (nothing anchors the walk back).
 */
export function bankBalanceContributor(
  txns: readonly CashPoolTxn[],
  balances: ReadonlyMap<string, readonly BalanceSnapshot[]>,
): NetWorthContributor {
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
        if (!BANK_BALANCE_TYPES.has(account.type)) continue;
        const rows = balances.get(account.id);
        if (rows === undefined || rows.length === 0) continue;
        out.set(account.id, new BackfilledBalanceValuation(rows, byAccount.get(account.id) ?? []));
      }
      return out;
    },
  };
}

/** Budget's contributor: the cash pools (`cashContributor`) and the bank accounts (`bankBalanceContributor`). */
export function budgetContributor(
  txns: readonly CashPoolTxn[],
  balances: ReadonlyMap<string, readonly BalanceSnapshot[]>,
): NetWorthContributor {
  const cash = cashContributor(txns);
  const bank = bankBalanceContributor(txns, balances);
  return {
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      return new Map([...cash.valuations(accounts), ...bank.valuations(accounts)]);
    },
  };
}
