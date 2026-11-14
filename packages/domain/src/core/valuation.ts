/**
 * How accounts are valued over time for net worth (`core/networth.py`, contributor protocol).
 *
 * Core values every account from its balance snapshots (`BalanceValuation`). A module that knows
 * better how to value the accounts it owns supplies a `NetWorthContributor`: loans value their
 * accounts by the amortization schedule, assets value vehicles by depreciation, budget values the
 * cash pool by its running transaction sum, investments value brokerage accounts by their positions.
 *
 * Python contributors read their tables through the session; here a contributor is a value the
 * store builds with the module's rows already loaded, so `valuations` only picks the accounts it
 * owns. Domain has no clock: `today` is passed in wherever Python calls `date.today()`.
 */

import type { IsoDate } from "../dates.js";
import type { Decimal } from "../decimal.js";
import { ZERO_00 } from "./zero.js";

/** The fields of an account net worth reads (`core.models.Account`). */
export interface NetWorthAccount {
  /** The account's id in the caller's id space (a gid in the store, a natural key in parity). */
  readonly id: string;
  /** Stored `accounts.type` (an account type registry id; unknown ids are liquid assets). */
  readonly type: string;
  /** Stored `accounts.currency`; net worth keeps every currency on its own. */
  readonly currency: string;
  readonly active: boolean;
  /** Set when the owner removed the position: never part of net worth, now or in the history. */
  readonly removedAt: string | null;
}

/** `(as-of date, raw value)` of an account for net worth now / at a date. */
export type LatestEntry = readonly [IsoDate, Decimal];

/** How one account is valued over time (raw balance, before the sign). */
export interface Valuation {
  /**
   * Value for net worth at `asOf`; `asOf = null` is "now": computed values use `today`, balance
   * snapshots are not cut off (Python's `as_of=None`). null = no data.
   */
  latest(asOf: IsoDate | null, today: IsoDate): LatestEntry | null;
  /** Value at `d` for the history series; null = no data yet. */
  at(d: IsoDate): Decimal | null;
  /** Dates that create points on the history series (may be empty). */
  axisDates(): readonly IsoDate[];
  /**
   * The first date the history knows this account's value; earlier points of the series miss it
   * (no data yet, not a zero). Absent or null: the value is known for every date (a computed value,
   * a pool that started empty).
   */
  knownFrom?(): IsoDate | null;
}

export interface NetWorthContributor {
  /** Valuations for those of `accounts` this module values (others omitted). */
  valuations(accounts: ReadonlyMap<string, NetWorthAccount>): ReadonlyMap<string, Valuation>;
}

/** A value computed for any date (loan outstanding, depreciated value). */
export class ComputedValuation implements Valuation {
  private readonly valueAt: (d: IsoDate) => Decimal;

  constructor(valueAt: (d: IsoDate) => Decimal) {
    this.valueAt = valueAt;
  }

  latest(asOf: IsoDate | null, today: IsoDate): LatestEntry {
    const ref = asOf ?? today;
    return [ref, this.valueAt(ref)];
  }

  at(d: IsoDate): Decimal {
    return this.valueAt(d);
  }

  axisDates(): IsoDate[] {
    return [];
  }
}

function lastAtOrBefore(points: readonly LatestEntry[], d: IsoDate): Decimal | null {
  let last: Decimal | null = null;
  for (const [pd, v] of points) {
    if (pd <= d) last = v;
    else break;
  }
  return last;
}

/**
 * A value known at points (ascending `[date, value]`); 0 before the first one for net worth now, no
 * value before it in the history (the cash pool).
 */
export class RunningValuation implements Valuation {
  private readonly points: readonly LatestEntry[];

  constructor(points: readonly LatestEntry[]) {
    this.points = points;
  }

  latest(asOf: IsoDate | null, today: IsoDate): LatestEntry {
    const ref = asOf ?? today;
    return [ref, lastAtOrBefore(this.points, ref) ?? ZERO_00];
  }

  at(d: IsoDate): Decimal | null {
    return lastAtOrBefore(this.points, d);
  }

  axisDates(): IsoDate[] {
    return this.points.map(([d]) => d);
  }

  /** The pool starts empty: before its first row it holds nothing, which is known. */
  knownFrom(): null {
    return null;
  }
}

/** A stored balance snapshot (`core.models.Balance`). */
export interface BalanceSnapshot {
  readonly date: IsoDate;
  readonly amount: Decimal;
  /** `Source` value: `open_banking`, `connector`, `csv`, `manual` (others rank last). */
  readonly source: string;
}

/**
 * Prefer Open Banking over CSV when two snapshots share the same date (OB is the more current and
 * authoritative source); a connector (a bank API or export converter) sits between.
 */
export const BALANCE_SOURCE_RANK: ReadonlyMap<string, number> = new Map([
  ["open_banking", 0],
  ["connector", 1],
  ["csv", 2],
  ["manual", 3],
]);

function sourceRank(source: string): number {
  return BALANCE_SOURCE_RANK.get(source) ?? 9;
}

/** Core default: the account's balance snapshots (a step function). */
export class BalanceValuation implements Valuation {
  private readonly rows: readonly BalanceSnapshot[];
  private readonly points: readonly LatestEntry[];

  /** `balances` in storage order (insertion order decides between equal dates). */
  constructor(balances: readonly BalanceSnapshot[]) {
    // Array.prototype.sort is stable: insertion order per day, like Python's sorted().
    this.rows = [...balances].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const byDate = new Map<IsoDate, Decimal>();
    for (const b of this.rows) byDate.set(b.date, b.amount); // last write per date wins
    this.points = [...byDate.entries()];
  }

  latest(asOf: IsoDate | null, _today: IsoDate): LatestEntry | null {
    let best: { date: IsoDate; rank: number; amount: Decimal } | null = null;
    for (const b of this.rows) {
      if (asOf !== null && b.date > asOf) continue;
      const rank = sourceRank(b.source);
      if (best === null || b.date > best.date || (b.date === best.date && rank < best.rank)) {
        best = { date: b.date, rank, amount: b.amount };
      }
    }
    return best === null ? null : [best.date, best.amount];
  }

  at(d: IsoDate): Decimal | null {
    return lastAtOrBefore(this.points, d);
  }

  axisDates(): IsoDate[] {
    return this.points.map(([d]) => d);
  }

  /** Before the first snapshot the balance is unknown. */
  knownFrom(): IsoDate | null {
    return this.points[0]?.[0] ?? null;
  }
}

/**
 * `valuations`: per account, the first contributor (module order) that values it, else its balance
 * snapshots. Accounts without any data are absent. `balances` maps account ids to their snapshots in
 * storage order; its key order is the order Python's balance query returns.
 */
export function resolveValuations(
  contributors: readonly NetWorthContributor[],
  accounts: ReadonlyMap<string, NetWorthAccount>,
  balances: ReadonlyMap<string, readonly BalanceSnapshot[]>,
): Map<string, Valuation> {
  const out = new Map<string, Valuation>();
  for (const contributor of contributors) {
    for (const [id, v] of contributor.valuations(accounts)) {
      if (!out.has(id)) out.set(id, v);
    }
  }
  for (const [id, rows] of balances) {
    if (rows.length === 0 || out.has(id) || !accounts.has(id)) continue;
    out.set(id, new BalanceValuation(rows));
  }
  return out;
}
