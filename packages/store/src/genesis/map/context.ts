// Shared shapes of the genesis row mappers (S26 spec 4, 9.2 `map/*`). A mapper turns one source row
// into the events of that row (contiguous in the log, spec 5.1) through the phase-1 gid map only
// (`GidResolver` and the hashes of phase 1), so the S31a shipper can reuse it with a resolver over
// Python's `sync_ids`. A row whose gid the resolver lacks was left out (and counted) by phase 1:
// mappers skip it silently.
//
// Stamps (events.md 4.4): every event of a row carries the row's timestamp columns (view column name
// -> value, null kept), not only the minimum the spec's 4.x tables list: reducers take the domain
// time of a column from any event that sets it (`updated_at` on every override event, ...), and every
// event of a snapshot describes the same final row. Device-local columns (connector fetch state) are
// never stamped.
import type { EventType } from "../../events/v1/catalog.js";
import { columnOf } from "../columns.js";
import type { VaultIds } from "../ids.js";
import type { Rewriter } from "../rewrite.js";
import type { GenesisFiles } from "../source.js";

export interface EventDraft {
  readonly type: EventType;
  readonly gid: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** The events of one source row; `localId` is its `ids` entry (none for cash-leg claims, cushion). */
export interface RowEvents {
  readonly table: string;
  readonly localId: string | undefined;
  readonly events: readonly EventDraft[];
}

/** What a mapper reads of phase 1 (`VaultIds`). */
type MapIds = Pick<
  VaultIds,
  | "det"
  | "resolver"
  | "accounts"
  | "instruments"
  | "budgetTxns"
  | "invDedupHashes"
  | "cashLegClaims"
>;

export interface MapContext {
  readonly ids: MapIds;
  readonly rw: Rewriter;
  /** The data dir's side files (archives of investment imports). */
  readonly files: GenesisFiles;
  /** Counts `(table, reason)` on this vault. */
  count(table: string, reason: string, n?: number): void;
  /**
   * Runs one row's mapping. Without `strict`, a row whose JSON holds an id no rule rewrites
   * (`unmapped_id_key`, already counted by the rewriter) is skipped instead of failing the run.
   */
  attempt(map: () => RowEvents | undefined): RowEvents | undefined;
}

type Stamps = Readonly<Record<string, string | null>>;

/** The `stamps` object of a row: each named timestamp field under its snake_case view column. */
export function stampsOf<F extends string>(
  row: Readonly<Record<F, string | null>>,
  fields: readonly F[],
): Stamps {
  const out: Record<string, string | null> = {};
  for (const field of fields) out[columnOf(field)] = row[field];
  return out;
}

/** One event of a row: `data` plus the row's stamps (none for rows without timestamps). */
export function event(
  type: EventType,
  gid: string,
  data: Readonly<Record<string, unknown>>,
  stamps?: Stamps,
): EventDraft {
  return { type, gid, data: stamps === undefined ? data : { ...data, stamps } };
}

/** The gid phase 1 gave a row, undefined when it left the row out. */
export function gidOf(
  ctx: MapContext,
  table: string,
  localId: string | number,
): string | undefined {
  return ctx.ids.resolver.gid(table, String(localId));
}

/**
 * A reference phase 1 guaranteed (gid.md 7.6 "row skipped" references: the row has a gid only when
 * they resolve). A miss is a genesis bug, never a data case.
 */
export function requiredGid(ctx: MapContext, table: string, localId: string | number): string {
  const gid = gidOf(ctx, table, localId);
  if (gid === undefined) throw new Error(`genesis invariant: ${table} reference without a gid`);
  return gid;
}

export function rowEvents(
  table: string,
  localId: string | number | undefined,
  events: readonly EventDraft[],
): RowEvents {
  return { table, localId: localId === undefined ? undefined : String(localId), events };
}

/** Maps every row through `map` (row order kept), dropping skipped rows. */
export function mapRows<R>(
  ctx: MapContext,
  rows: readonly R[],
  map: (row: R, ctx: MapContext) => RowEvents | undefined,
): RowEvents[] {
  const out: RowEvents[] = [];
  for (const row of rows) {
    const mapped = ctx.attempt(() => map(row, ctx));
    if (mapped !== undefined) out.push(mapped);
  }
  return out;
}
