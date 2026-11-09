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
 * balance is the opening one: known when it is zero (the account started empty), back to `windowStart`
 * when the import is known to have asked from that day (a quiet account had no transactions since),
 * unknown otherwise. Net worth now (`latest`) is the snapshots' own value, unchanged.
 */
export class BackfilledBalanceValuation implements Valuation {
  private readonly snapshots: BalanceValuation;
  private readonly first: IsoDate | null;
  /** `[day, end-of-day balance]` of the transaction days before the first snapshot, ascending. */
  private readonly back: readonly LatestEntry[];
  /** The balance before the first transaction (or the first snapshot's when none is earlier). */
  private readonly opening: Decimal | null;
  /** The first day the import asked for: the opening balance holds from it (null: unknown). */
  private readonly windowStart: IsoDate | null;

  constructor(
    balances: readonly BalanceSnapshot[],
    txns: readonly CashPoolTxn[],
    windowStart: IsoDate | null = null,
  ) {
    this.snapshots = new BalanceValuation(balances);
    this.first = this.snapshots.knownFrom();
    const anchor = this.first === null ? null : this.snapshots.at(this.first);
    const first = this.first;
    if (first === null || anchor === null) {
      this.back = [];
      this.opening = null;
      this.windowStart = null;
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
    const earliest = this.back[0]?.[0] ?? first;
    this.windowStart = windowStart !== null && windowStart < earliest ? windowStart : null;
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
    if (this.opening?.isZero()) return ZERO_00;
    return this.windowStart !== null && d >= this.windowStart ? this.opening : null;
  }

  axisDates(): IsoDate[] {
    return [
      ...(this.windowStart === null ? [] : [this.windowStart]),
      ...this.back.map(([d]) => d),
      ...this.snapshots.axisDates(),
    ];
  }

  knownFrom(): IsoDate | null {
    if (this.opening?.isZero()) return null;
    return this.windowStart ?? this.back[0]?.[0] ?? this.first;
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
  windowStarts: ReadonlyMap<string, IsoDate> = new Map(),
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
        out.set(
          account.id,
          new BackfilledBalanceValuation(
            rows,
            byAccount.get(account.id) ?? [],
            windowStarts.get(account.id) ?? null,
          ),
        );
      }
      return out;
    },
  };
}

/** Budget's contributor: the cash pools (`cashContributor`) and the bank accounts (`bankBalanceContributor`). */
export function budgetContributor(
  txns: readonly CashPoolTxn[],
  balances: ReadonlyMap<string, readonly BalanceSnapshot[]>,
  windowStarts: ReadonlyMap<string, IsoDate> = new Map(),
): NetWorthContributor {
  const cash = cashContributor(txns);
  const bank = bankBalanceContributor(txns, balances, windowStarts);
  return {
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      return new Map([...cash.valuations(accounts), ...bank.valuations(accounts)]);
    },
  };
}

/** One Open Banking import batch: its account, bank, day and earliest booked transaction. */
export interface OpenBankingBatch {
  readonly account: string;
  readonly bank: string;
  /** The day the batch ran. */
  readonly day: IsoDate;
  /** Its earliest booking date; null when it brought no transaction. */
  readonly first: IsoDate | null;
}

/**
 * The first day each account's first Open Banking fetch asked for. The accounts of one bank fetched
 * on the same day share the window (one consent, one request range), so its start is the earliest
 * transaction any of them got that day; a quiet account (savings) whose own first transaction comes
 * weeks later held its opening balance since then. An account first fetched on another day gets its
 * own group, and a group without any transaction gets none.
 */
export function openBankingWindowStarts(
  batches: readonly OpenBankingBatch[],
): Map<string, IsoDate> {
  const firstDay = new Map<string, { bank: string; day: IsoDate }>();
  for (const b of batches) {
    const seen = firstDay.get(b.account);
    if (seen === undefined || b.day < seen.day)
      firstDay.set(b.account, { bank: b.bank, day: b.day });
  }
  const groupStart = new Map<string, IsoDate>();
  for (const b of batches) {
    if (b.first === null) continue;
    const key = `${b.bank}\u0000${b.day}`;
    const seen = groupStart.get(key);
    if (seen === undefined || b.first < seen) groupStart.set(key, b.first);
  }
  const out = new Map<string, IsoDate>();
  for (const [account, { bank, day }] of firstDay) {
    const start = groupStart.get(`${bank}\u0000${day}`);
    if (start !== undefined) out.set(account, start);
  }
  return out;
}
