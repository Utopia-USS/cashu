/**
 * Import dedup and occurrence numbering (Python `dedup.prepare_new_transactions`, verbatim semantics).
 *
 * Pass 1: an incoming row whose bank transaction id a stored row carries is a duplicate (and consumes
 * that row's content-hash slot); otherwise it consumes an unused stored row of the same content hash.
 * Pass 2, the newest-day rule (Open Banking, connectors, cashu-budget-import documents; bank CSV imports
 * run without it): stored history is authoritative from its oldest to its newest day; an unmatched row
 * in that span is `overlap`, on the newest day only while a same-amount stored row is left unmatched.
 * A new row's `occurrence` = stored rows with its hash + earlier new rows of this import with it.
 */

import type { IsoDate } from "../../dates.js";
import { type Decimal, format2 } from "../../decimal.js";
import { dedupHashV2 } from "./contentKey.js";
import { type NewTransaction, toNewTransaction } from "./newTransaction.js";
import type { RawTransaction } from "./types.js";

/**
 * One stored row of the (resolved) account, from the view. The caller passes EVERY row of the account
 * in storage order, including cash legs (`cashleg:` / `cashexp:`) and `legacy:` rows: they never match
 * a v2 hash but count for the newest-day rule's oldest and newest day, as Python's query did.
 */
export interface StoredTxn {
  readonly dedupHash: string;
  readonly bankTransactionId: string | null;
  readonly bookingDate: IsoDate;
  readonly amount: Decimal;
}

export type RowStatus = "new" | "duplicate" | "overlap";

export interface ImportPlan {
  /** One per incoming row, in order. */
  readonly statuses: readonly RowStatus[];
  readonly toInsert: readonly NewTransaction[];
  readonly numDuplicates: number;
  readonly numOverlap: number;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

export function planImport(
  stored: readonly StoredTxn[],
  raws: readonly RawTransaction[],
  opts: { readonly newestDayRule?: boolean } = {},
): ImportPlan {
  const existingBtids = new Map<string, string>();
  const existingCounts = new Map<string, number>();
  for (const t of stored) {
    if (t.bankTransactionId) existingBtids.set(t.bankTransactionId, t.dedupHash);
    bump(existingCounts, t.dedupHash);
  }

  const used = new Map<string, number>();
  const hashes: string[] = [];
  const matched: boolean[] = [];
  for (const raw of raws) {
    const h = dedupHashV2(raw);
    hashes.push(h);
    const btidHash = raw.bankTransactionId ? existingBtids.get(raw.bankTransactionId) : undefined;
    if (btidHash !== undefined) {
      bump(used, btidHash);
      matched.push(true);
    } else if ((used.get(h) ?? 0) < (existingCounts.get(h) ?? 0)) {
      bump(used, h);
      matched.push(true);
    } else {
      matched.push(false);
    }
  }

  let latest: IsoDate | undefined;
  let earliest: IsoDate | undefined;
  const spare = new Map<string, number>();
  if (opts.newestDayRule && stored.length > 0) {
    for (const t of stored) {
      if (latest === undefined || t.bookingDate > latest) latest = t.bookingDate;
      if (earliest === undefined || t.bookingDate < earliest) earliest = t.bookingDate;
    }
    const onLatest = new Map<string, StoredTxn>();
    for (const t of stored) if (t.bookingDate === latest) onLatest.set(t.dedupHash, t);
    for (const [h, t] of onLatest) {
      // PARITY(Q9): counts the hash's stored rows of ALL days, so it can over-count spare slots.
      const count = existingCounts.get(h) ?? 0;
      const free = count - Math.min(used.get(h) ?? 0, count);
      if (free > 0) bump(spare, format2(t.amount), free);
    }
  }

  const statuses: RowStatus[] = [];
  const toInsert: NewTransaction[] = [];
  const created = new Map<string, number>();
  let numDuplicates = 0;
  let numOverlap = 0;
  raws.forEach((raw, i) => {
    const h = hashes[i] as string;
    if (matched[i]) {
      numDuplicates++;
      statuses.push("duplicate");
      return;
    }
    if (
      latest !== undefined &&
      earliest !== undefined &&
      earliest <= raw.bookingDate &&
      raw.bookingDate <= latest
    ) {
      const key = format2(raw.amount);
      if (raw.bookingDate < latest || (spare.get(key) ?? 0) > 0) {
        if (raw.bookingDate === latest) bump(spare, key, -1);
        numOverlap++;
        statuses.push("overlap");
        return;
      }
    }
    const occurrence = (existingCounts.get(h) ?? 0) + (created.get(h) ?? 0);
    bump(created, h);
    statuses.push("new");
    toInsert.push(toNewTransaction(raw, h, occurrence));
  });
  return { statuses, toInsert, numDuplicates, numOverlap };
}
