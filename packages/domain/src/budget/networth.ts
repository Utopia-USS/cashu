/**
 * Budget's net-worth contributors: a cash pool account is worth the running sum of its transactions,
 * never a balance snapshot (`modules/budget/networth.py`, `CashContributor`); a bank account is worth
 * its balance snapshots, and before the first one the history walks back from it over the imported
 * transactions (`bankBalanceContributor`).
 */

import {
  type BalanceSnapshot,
  BalanceValuation,
  type DerivedNetWorthAccount,
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
  /**
   * The row's own currency. Absent: the account's currency (a caller whose rows cannot carry
   * another one). The store always passes it: a pool row in another currency is a foreign or
   * malformed event, never a command of this app.
   */
  readonly currency?: string;
}

/**
 * The id of the part of pool `poolId` held in `currency`, when that is not the pool's own currency:
 * net worth counts it as an account of that currency beside the pool (`cashContributor`).
 */
export function cashPoolPartId(poolId: string, currency: string): string {
  return `${poolId}#${currency}`;
}

/** The pool and currency of a `cashPoolPartId`; null for any other id (a gid never holds `#`). */
export function cashPoolPartOf(
  id: string,
): { readonly pool: string; readonly currency: string } | null {
  const at = id.lastIndexOf("#");
  if (at <= 0 || at === id.length - 1) return null;
  return { pool: id.slice(0, at), currency: id.slice(at + 1) };
}

/**
 * The stored account behind net-worth line `id` (a pool part: its pool) with the name to show: a
 * part is named after its pool plus the currency code ("Cash (EUR)"), every other line keeps its
 * own. `undefined` when `metaOf` knows neither. The one place a part's name is composed.
 */
export function netWorthLineMeta<M extends { readonly name: string }>(
  id: string,
  metaOf: (gid: string) => M | undefined,
): M | undefined {
  const own = metaOf(id);
  if (own !== undefined) return own;
  const part = cashPoolPartOf(id);
  if (part === null) return undefined;
  const pool = metaOf(part.pool);
  return pool === undefined ? undefined : { ...pool, name: `${pool.name} (${part.currency})` };
}

/** Budget's cash contributor: the pools by their own currency and their parts in other currencies. */
export interface CashPoolContributor extends NetWorthContributor {
  /** The parts of the stored pools in another currency, each after its pool (`DerivedNetWorthAccount`). */
  derivedAccounts(stored: readonly NetWorthAccount[]): DerivedNetWorthAccount[];
}

/** `[booking date, running sum]` of `rows`, sorted stably by booking date, last value per date. */
function runningSum(rows: readonly CashPoolTxn[]): RunningValuation {
  const sorted = [...rows].sort((a, b) =>
    a.bookingDate < b.bookingDate ? -1 : a.bookingDate > b.bookingDate ? 1 : 0,
  );
  const byDate = new Map<IsoDate, Decimal>();
  let run = ZERO_00;
  for (const t of sorted) {
    run = run.add(t.amount);
    byDate.set(t.bookingDate, run);
  }
  return new RunningValuation([...byDate.entries()]);
}

/**
 * The contributor over the profile's transactions (any account; rows of other accounts are ignored).
 * `txns` MUST be in anchor order (Python's id order): PARITY(Q13) each pool's rows are sorted stably by
 * booking date, so input order breaks ties like Python's `(booking_date, id)`; the running sum starts at
 * `Decimal("0.00")` and the last value of each date is the point. Every cash account gets a valuation,
 * an empty one when it has no rows.
 *
 * A pool is worth the running sum of its rows in its own currency only. Its rows in another currency
 * (a foreign or malformed event: the app's own commands route a cash row to the pool of its currency)
 * are never added to it (data-safety rule 5): they form a part of the pool in that currency
 * (`derivedAccounts`, id `cashPoolPartId`), counted in that currency's net worth like any account of
 * it, the way the phone's `accountBalances` reports them.
 */
export function cashContributor(txns: readonly CashPoolTxn[]): CashPoolContributor {
  // per account, per row currency (`null`: the account's own); input order kept
  const byAccount = new Map<string, Map<string | null, CashPoolTxn[]>>();
  // part id -> the pool's rows in that currency
  const partRows = new Map<string, CashPoolTxn[]>();
  for (const t of txns) {
    let byCurrency = byAccount.get(t.account);
    if (byCurrency === undefined) {
      byCurrency = new Map();
      byAccount.set(t.account, byCurrency);
    }
    const key = t.currency ?? null;
    const list = byCurrency.get(key);
    if (list === undefined) byCurrency.set(key, [t]);
    else list.push(t);
    if (key !== null) {
      const id = cashPoolPartId(t.account, key);
      const part = partRows.get(id);
      if (part === undefined) partRows.set(id, [t]);
      else part.push(t);
    }
  }
  return {
    derivedAccounts(stored: readonly NetWorthAccount[]): DerivedNetWorthAccount[] {
      return stored.flatMap((pool) => {
        if (pool.type !== CASH_ACCOUNT_TYPE) return [];
        const others = [...(byAccount.get(pool.id)?.keys() ?? [])]
          .filter((c): c is string => c !== null && c !== pool.currency)
          .sort();
        return others.map((currency) => ({
          of: pool.id,
          account: { ...pool, id: cashPoolPartId(pool.id, currency), currency },
        }));
      });
    },
    valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation> {
      const out = new Map<string, Valuation>();
      for (const account of accounts.values()) {
        if (account.type !== CASH_ACCOUNT_TYPE) continue;
        const part = byAccount.has(account.id) ? undefined : partRows.get(account.id);
        if (part !== undefined) {
          // a part of a pool in another currency (`derivedAccounts`)
          out.set(account.id, runningSum(part));
          continue;
        }
        // a stored pool: its rows in its own currency; a row without a currency is its own
        const own = byAccount.get(account.id);
        const explicit = own?.get(account.currency) ?? [];
        const implicit = own?.get(null) ?? [];
        const rows =
          implicit.length === 0
            ? explicit
            : explicit.length === 0
              ? implicit
              : inInputOrder(txns, [...explicit, ...implicit]);
        out.set(account.id, runningSum(rows));
      }
      return out;
    },
  };
}

/** `rows` (a subset of `txns`) back in the order of `txns`: equal booking dates keep input order. */
function inInputOrder(txns: readonly CashPoolTxn[], rows: readonly CashPoolTxn[]): CashPoolTxn[] {
  const keep = new Set(rows);
  return txns.filter((t) => keep.has(t));
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
 * (nothing anchors the walk back). The walk back uses the rows in the account's currency only (a row
 * without one is the account's): a row in another currency (a foreign or malformed event) is never
 * subtracted from a balance in this one (data-safety rule 5), and nothing anchors a balance in its
 * own currency, so it counts in no history.
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
            (byAccount.get(account.id) ?? []).filter(
              (t) => t.currency === undefined || t.currency === account.currency,
            ),
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
): CashPoolContributor {
  const cash = cashContributor(txns);
  const bank = bankBalanceContributor(txns, balances, windowStarts);
  return {
    derivedAccounts: (stored) => cash.derivedAccounts(stored),
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
