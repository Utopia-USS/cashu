/**
 * The processing order shared by the lot engine and the last trade prices: transactions in
 * chronological order (`compareChronological`) with each rename placed before the first transaction
 * of its date (renames of one date keep their given order). Also the rename redirect chain.
 */

import type { InstrumentRename } from "../domain/instrument.js";
import { compareChronological, type Transaction } from "../domain/transaction.js";
import type { InstrumentId } from "../domain/values.js";

export type PortfolioEvent =
  | { readonly kind: "txn"; readonly txn: Transaction }
  | { readonly kind: "rename"; readonly rename: InstrumentRename; readonly index: number };

/** Python's `sorted` of `((date, 0|1, key), event)`: stable, renames first within a date. */
export function orderEvents(
  txns: readonly Transaction[],
  renames: readonly InstrumentRename[],
): PortfolioEvent[] {
  const events: PortfolioEvent[] = [
    ...txns.map((txn): PortfolioEvent => ({ kind: "txn", txn })),
    ...renames.map((rename, index): PortfolioEvent => ({ kind: "rename", rename, index })),
  ];
  const dateOf = (e: PortfolioEvent) => (e.kind === "txn" ? e.txn.tradeDate : e.rename.date);
  return events.sort((a, b) => {
    const da = dateOf(a);
    const db = dateOf(b);
    if (da !== db) return da < db ? -1 : 1;
    if (a.kind !== b.kind) return a.kind === "rename" ? -1 : 1;
    if (a.kind === "txn" && b.kind === "txn") return compareChronological(a.txn, b.txn);
    if (a.kind === "rename" && b.kind === "rename") return a.index - b.index;
    return 0;
  });
}

/** Follows `redirect` from `instrumentId` to the current instrument (a cycle stops at the last hop). */
export function resolveRedirect(
  redirect: ReadonlyMap<InstrumentId, InstrumentId>,
  instrumentId: InstrumentId | null,
): InstrumentId | null {
  const seen = new Set<InstrumentId>();
  let current = instrumentId;
  while (current !== null && redirect.has(current) && !seen.has(current)) {
    seen.add(current);
    current = redirect.get(current) as InstrumentId;
  }
  return current;
}
