/**
 * Chronological ranking of the rows of one file (R9), the source of their `createdAt` order (port of
 * `importing/ordering.py`).
 *
 * Positions are derived in `compareChronological` order (trade date, `createdAt`, id), so the import
 * gives the rows of one file strictly increasing `createdAt` values in chronological order:
 *
 * - by trade date;
 * - rows of the same date by time of day when every row of that date has one (a comparator mixing
 *   timed and untimed rows would not be transitive);
 * - then file order, reversed when the file lists newest first (its first row is later than its last
 *   by date, or by time on the same date), so same-day rows keep their real sequence.
 */

import { addMicroseconds, type DateTime } from "../../dates.js";
import type { ParsedTxn, TimeOfDay } from "./contract.js";

/** `DEFAULT_STEP`: one millisecond, in microseconds. */
export const DEFAULT_STEP_MICROS = 1000;

function compareTime(a: TimeOfDay, b: TimeOfDay): number {
  return a.hour - b.hour || a.minute - b.minute || a.second - b.second;
}

/** True when the file lists newest rows first (first row later than the last one). */
export function isNewestFirst(txns: readonly ParsedTxn[]): boolean {
  const first = txns[0];
  const last = txns[txns.length - 1];
  if (txns.length < 2 || first === undefined || last === undefined) return false;
  if (first.tradeDate !== last.tradeDate) return first.tradeDate > last.tradeDate;
  return (
    first.tradeTime !== null &&
    last.tradeTime !== null &&
    compareTime(first.tradeTime, last.tradeTime) > 0
  );
}

/** Rank (0-based) of every row in chronological order, in input order. */
export function chronologicalRanks(txns: readonly ParsedTxn[]): readonly number[] {
  const newestFirst = isNewestFirst(txns);
  const timedDates = new Map<string, boolean>();
  for (const txn of txns) {
    timedDates.set(
      txn.tradeDate,
      (timedDates.get(txn.tradeDate) ?? true) && txn.tradeTime !== null,
    );
  }
  type Entry = { readonly txn: ParsedTxn; readonly index: number };
  const compare = (a: Entry, b: Entry): number => {
    const ta = a.txn;
    const tb = b.txn;
    if (ta.tradeDate !== tb.tradeDate) return ta.tradeDate < tb.tradeDate ? -1 : 1;
    if (timedDates.get(ta.tradeDate) && ta.tradeTime !== null && tb.tradeTime !== null) {
      const byTime = compareTime(ta.tradeTime, tb.tradeTime);
      if (byTime !== 0) return byTime;
    }
    return newestFirst ? b.index - a.index : a.index - b.index;
  };
  const order = txns.map((txn, index): Entry => ({ txn, index })).sort(compare);
  const ranks = new Array<number>(txns.length).fill(0);
  order.forEach((entry, rank) => {
    ranks[entry.index] = rank;
  });
  return Object.freeze(ranks);
}

/**
 * `createdAt` per row (input order): `base + rank * step`, strictly increasing in chronological order.
 */
export function createdAtStamps(
  txns: readonly ParsedTxn[],
  base: DateTime,
  stepMicros: number = DEFAULT_STEP_MICROS,
): readonly DateTime[] {
  return Object.freeze(
    chronologicalRanks(txns).map((rank) => addMicroseconds(base, rank * stepMicros)),
  );
}
