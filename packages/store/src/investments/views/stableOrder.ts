/** Metadata-only creation ranks. Local view ids and log insertion seq are never chronology. */
import { compareHlc } from "@cashu/sync/hlc";
import type { Read } from "../../core/queries.js";

const ENTITIES = {
  theses: ["inv_theses", "thesis.created"],
  ruleRuns: ["inv_rule_runs", "ruleRun.finished"],
  researchRuns: ["research_runs", "researchRun.started"],
  researchNotes: ["research_notes", "note.added"],
  signals: ["inv_signals", "signal.opened"],
  reviews: ["reviews", "review.done"],
  decisions: ["inv_decisions", "decision.recorded"],
  imports: ["inv_import_batches", "invImport.recorded"],
  alerts: ["alerts", "alert.created"],
  watchlist: ["watchlist_items", "watchlist.added"],
} as const;
export type RankedEntity = keyof typeof ENTITIES;
export interface StableReadRank {
  readonly gid: string;
  readonly hlc: string;
  readonly eid: string;
}

/** The public-row join is required: event_log itself does not participate in table invalidation. */
export function creationRanks(
  read: Read,
  entity: RankedEntity,
  gids?: readonly string[],
): Map<string, StableReadRank> {
  if (gids !== undefined && gids.length > 500) {
    const result = new Map<string, StableReadRank>();
    for (let start = 0; start < gids.length; start += 500)
      for (const [gid, rank] of creationRanks(read, entity, gids.slice(start, start + 500)))
        result.set(gid, rank);
    return result;
  }
  const [table, type] = ENTITIES[entity];
  const filter =
    gids === undefined
      ? ""
      : gids.length === 0
        ? " WHERE 0"
        : ` WHERE v.gid IN (${gids.map(() => "?").join(",")})`;
  const rows = read<{ gid: string; hlc: string | null; eid: string | null }>(
    `SELECT v.gid, e.hlc, e.eid FROM ${table} v LEFT JOIN event_log e
     ON e.gid = v.gid AND e.type = ? AND e.state = 'applied'
     AND NOT EXISTS (SELECT 1 FROM event_log earlier WHERE earlier.gid = e.gid
       AND earlier.type = e.type AND earlier.state = 'applied'
       AND (earlier.hlc COLLATE BINARY < e.hlc COLLATE BINARY OR
         (earlier.hlc = e.hlc AND earlier.eid COLLATE BINARY < e.eid COLLATE BINARY)))${filter}`,
    type,
    ...(gids ?? []),
  );
  return new Map(
    rows.map((row) => {
      if (row.hlc === null || row.eid === null)
        throw new Error("public entity is missing its applied creation anchor");
      return [row.gid, { gid: row.gid, hlc: row.hlc, eid: row.eid }];
    }),
  );
}

export function compareReadRank(a: StableReadRank, b: StableReadRank): number {
  return compareHlc(a.hlc, b.hlc) || (a.eid < b.eid ? -1 : a.eid > b.eid ? 1 : 0);
}
export function rankOf(ranks: ReadonlyMap<string, StableReadRank>, gid: string): StableReadRank {
  const rank = ranks.get(gid);
  if (rank === undefined) throw new Error("entity is missing its creation rank");
  return rank;
}

/** Stable creation order; callers keep their domain timestamps as primary order. */
export function byCreation<T extends { readonly gid: string }>(
  read: Read,
  entity: RankedEntity,
  rows: readonly T[],
  descending = false,
): T[] {
  const ranks = creationRanks(
    read,
    entity,
    rows.map((row) => row.gid),
  );
  return [...rows].sort(
    (a, b) => (descending ? -1 : 1) * compareReadRank(rankOf(ranks, a.gid), rankOf(ranks, b.gid)),
  );
}

export function newestFirst<T extends { readonly gid: string }>(
  read: Read,
  entity: RankedEntity,
  rows: readonly T[],
  time: (row: T) => string | bigint,
): T[] {
  return byCreation(read, entity, rows, true).sort((a, b) => {
    const left = time(a);
    const right = time(b);
    return left < right ? 1 : left > right ? -1 : 0;
  });
}
