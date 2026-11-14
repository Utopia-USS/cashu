// Review records (Python `core/reviews.py`, read side): "I looked at module X". The `reviews` table
// is folded by the investments materializer (`investments/reviews.ts`); undone reviews are gone (TOMB).

import { newestFirst } from "../views/stableOrder.js";
import { jsonObject, type Read } from "./shared.js";

export interface ReviewView {
  readonly gid: string;
  readonly module: string;
  /** View timestamp (`YYYY-MM-DD HH:MM:SS.ffffff`, naive UTC): the event time, or 12:00 UTC of a past day. */
  readonly doneAt: string;
  readonly notes: string | null;
  /** Counts at that moment; a backdated review carries `recorded_at` (when it was saved). */
  readonly stats: Readonly<Record<string, unknown>>;
}

interface Row {
  gid: string;
  module: string;
  doneAt: string;
  notes: string | null;
  stats: string;
}

const SQL = "SELECT gid, module, done_at AS doneAt, notes, stats FROM reviews";

const toView = (r: Row): ReviewView => ({ ...r, stats: jsonObject(r.stats) });

/** Python `last`: the newest review of `module` (undefined: never reviewed). */
export function lastReview(read: Read, module: string): ReviewView | undefined {
  return newestFirst(
    read,
    "reviews",
    read<Row>(`${SQL} WHERE module = ?`, module).map(toView),
    (row) => row.doneAt,
  )[0];
}

/**
 * Python `list_reviews`: newest first, of one module when `module` is non-empty; `limit` is clamped
 * to 1..500 (default 50).
 */
export function reviews(read: Read, module?: string | null, limit = 50): ReviewView[] {
  const n = Math.max(1, Math.min(Math.trunc(limit), 500));
  const rows = module ? read<Row>(`${SQL} WHERE module = ?`, module) : read<Row>(SQL);
  return newestFirst(read, "reviews", rows.map(toView), (row) => row.doneAt).slice(0, n);
}

/** Python `get`: the review `gid` of this vault (another vault's, or an undone one, is undefined). */
export function reviewByGid(read: Read, gid: string): ReviewView | undefined {
  const row = read<Row>(`${SQL} WHERE gid = ?`, gid)[0];
  return row === undefined ? undefined : toView(row);
}
