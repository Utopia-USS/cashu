// Contracts between the fold engine and the module materializers and derivers.
import type { PaymentPattern } from "@cashu/domain/core";
import type { DetGid } from "../gid.js";
import type { TableDef } from "../sql/ddl.js";
import type { SqlRunResult, SqlValue } from "../sql/driver.js";
import type { Payload } from "../upcast.js";

/** A decoded, applied event as a materializer sees it: payload already upcast to the current version. */
export interface FoldEvent {
  readonly eid: string;
  readonly hlc: string;
  readonly at: string;
  readonly type: string;
  readonly v: number;
  readonly gid: string;
  readonly device: string;
  readonly data: Payload;
  readonly cause?: string;
  readonly origin?: string;
}

/** The fold order key: `(hlc, eid)` as one string (both fixed width, so string order = fold order). */
export function ord(e: { readonly hlc: string; readonly eid: string }): string {
  return e.hlc + e.eid;
}

export function compareOrd(a: FoldEvent, b: FoldEvent): number {
  const x = ord(a);
  const y = ord(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** SQL access for a materializer: reads anywhere in its own tables, writes recorded per table. */
/** The read half of `ViewSql` (what a contribution needs; a query's read handle provides it too). */
type ViewReader = Pick<ViewSql, "all">;

export interface ViewSql {
  write(table: string, sql: string, ...params: SqlValue[]): SqlRunResult;
  /**
   * Queue one row of `<insert> VALUES <row>` (e.g. `INSERT OR IGNORE INTO t (a, b)`, `(?, ?)`):
   * consecutive rows of one statement run as multi-row inserts. Every other call on this object
   * (and `flush`) runs the queue first, in order, so reads and writes see every queued row.
   */
  insert(table: string, insert: string, row: string, ...params: SqlValue[]): void;
  /** Run the queued inserts (the runner calls it at the end of each fold step). */
  flush(): void;
  get<R>(sql: string, ...params: SqlValue[]): R | undefined;
  all<R>(sql: string, ...params: SqlValue[]): R[];
}

/**
 * The partition index of one materializer (its `members_<id>` table): which subject gids (the gids events are
 * addressed to) belong to which partition (row key) under the current identity resolution. The
 * engine uses it to find every event of a partition when it must be re-folded (events.md 6.1).
 */
export interface FoldMembers {
  add(partition: string, subject: string, role?: string): void;
  partitionsOf(subject: string): readonly string[];
  roleOf(subject: string, partition: string): string | null;
  subjectsOf(partition: string): readonly { subject: string; role: string | null }[];
}

export interface FoldContext {
  readonly vault: string;
  readonly sql: ViewSql;
  readonly members: FoldMembers;
  /** The view-local integer id of a gid (stable for the life of the view). */
  id(gid: string): number;
  /** `resolve(g)` of an identity kind (events.md 6.4): the root of g's component, g itself if alone. */
  resolve(kind: string, gid: string): string;
  /** Every gid of the component whose root is `root` (root included). */
  identityMembers(kind: string, root: string): readonly string[];
  /** The value an accepted exclusive claim of this event recorded (accounts: the claimed IBAN). */
  accepted(kind: string, eid: string): string | undefined;
  readonly det: DetGid;
  /** Gids of applied events (of any materializer) whose `refs` include `subject`. */
  referrers(subject: string): readonly string[];
  /**
   * The first applied event of `type` carrying `gid`, in fold order. For a payload-derived DET type
   * every applied event of one gid names the same row key (events.md 7.10), so this maps a member gid
   * to its row without a partition index.
   */
  keyedEvent(gid: string, type: string): FoldEvent | undefined;
  /**
   * Domain time of `e` for view column `column` (events.md 4.4): `data.stamps[column]`, else the
   * payload's explicit time, else `at`; as a view timestamp.
   */
  time(e: FoldEvent, column: string, explicit?: string | null): string;
}

/**
 * One materializer: folds a set of event types into its own tables. Deterministic: the result is a
 * function of the applied events in `(hlc, eid)` order and the identity resolution, nothing else (no
 * clock, no randomness, no other materializer's tables).
 */
export interface Materializer {
  /** `<module>.<name>`, stable. */
  readonly id: string;
  /** Bump when the fold changes: the view is rebuilt on the next open. */
  readonly version: number;
  readonly tables: readonly TableDef[];
  readonly handles: readonly string[];
  /** Identity kinds whose resolution this fold reads: a root change re-folds it entirely. */
  readonly identity?: readonly string[];
  /** Identity kinds whose accepted claim values this fold reads (a change re-folds it entirely). */
  readonly accepted?: readonly string[];
  /**
   * Partitions (row keys) `e` affects under the current state. Subject-addressed events usually
   * return `ctx.members.partitionsOf(e.gid)`; an event whose subject is not known yet returns [].
   */
  partitions(e: FoldEvent, ctx: FoldContext): readonly string[];
  /** Extra subjects of a partition beyond its members table. */
  subjects?(partition: string, ctx: FoldContext): readonly string[];
  /**
   * Extra subjects an event belongs to beyond its gid: re-folding a partition that holds the event
   * also loads the events addressed to them (the signals a decision links, a transaction's leg gid).
   */
  refs?(e: FoldEvent, det: DetGid): readonly string[];
  /**
   * Index this materializer's refs lazily (the first `referrers` call after new events) instead of
   * on every apply. Only for a fold whose `subjects` already yield every gid a ref reaches, so a
   * partition re-fold never needs the refs index to find an event.
   */
  readonly refsOnDemand?: boolean;
  /** Delete the rows (public and internal) of these partitions. */
  clear(partitions: readonly string[], ctx: FoldContext): void;
  apply(e: FoldEvent, ctx: FoldContext): void;
}

/** What a deriver writes: whole columns of a table, or the rows a SQL predicate selects (S24 4.1). */
export type DerivedWrite =
  | { readonly table: string; readonly columns: readonly string[] }
  | { readonly table: string; readonly rows: string };

/**
 * Per input (a materializer id, or `CONTRIBUTIONS`): the partitions its runner folded in this apply
 * (append: the events' partitions; partition re-fold: the closure it cleared), or `"all"` (a full
 * re-fold, an identity root change, a touched contribution table). Inputs absent from the map did not
 * change.
 */
export type DirtyPartitions = ReadonlyMap<string, ReadonlySet<string> | "all">;

/** The dirty-input id of the cross-module contributions (any table a contribution reads touched). */
export const CONTRIBUTIONS = "contributions";

/**
 * What a module contributes to another module's derivation without being imported by it (Python
 * `core.modules`: `payment_patterns`, `not_subscription_categories`). `reads` names the view tables
 * the contribution reads: touching one marks `CONTRIBUTIONS` dirty for every deriver that inputs it.
 */
export interface ModuleContributions {
  /** Read-only: a deriver passes its `ViewSql`, a query (the recurring view) its read handle. */
  readonly paymentPatterns?: (sql: ViewReader) => readonly PaymentPattern[];
  readonly notSubscriptionCategories?: readonly string[];
  readonly reads: readonly string[];
}

/** The contributions of every registered module, as a deriver reads them. */
export interface Contributions {
  paymentPatterns(): readonly PaymentPattern[];
  notSubscriptionCategories(): ReadonlySet<string>;
}

/** What a deriver sees: the view (writes recorded per table for `touchedTables`), gids, identity. */
export interface DeriveContext {
  readonly sql: ViewSql;
  readonly det: DetGid;
  /** The view-local integer id of a gid (stable for the life of the view). */
  id(gid: string): number;
  resolve(kind: string, gid: string): string;
  identityMembers(kind: string, root: string): readonly string[];
  readonly contributions: Contributions;
}

/**
 * A post-fold step that recomputes derived columns or rows from several materializers' output (S24
 * 4.1, events.md 9). Runs after every materializer, in registry order, inside the apply transaction;
 * each deriver sees the previous derivers' writes. Deterministic like a materializer: a function of
 * the view its inputs produced, never of the previous derived values, a clock or randomness.
 */
export interface Deriver {
  /** `<module>.<name>`, stable. */
  readonly id: string;
  /** Bump when the derivation changes: the view is rebuilt on the next open. */
  readonly version: number;
  /** Its internal tables. */
  readonly tables?: readonly TableDef[];
  readonly writes: readonly DerivedWrite[];
  /** Materializer ids (and `CONTRIBUTIONS`) whose dirty partitions make it run. */
  readonly inputs: readonly string[];
  /** Re-derive what the dirty partitions can affect; must equal `deriveAll` restricted to them. */
  derive(dirty: DirtyPartitions, ctx: DeriveContext): void;
  deriveAll(ctx: DeriveContext): void;
}

export interface IdentityClaim {
  readonly gid: string;
  readonly key: string;
  /** Recorded as the event's accepted value when an exclusive key claim is accepted. */
  readonly value?: string;
}

export interface IdentityConflict {
  readonly eid: string;
  readonly hlc: string;
  readonly gid: string;
  readonly key: string | null;
  readonly reason: "second-exclusive-key" | "union-refused";
}

/** An identity kind (events.md 6.4): claims and merges folded by a union-find in `(hlc, eid)` order. */
export interface IdentityKind {
  readonly id: string;
  readonly version: number;
  readonly handles: readonly string[];
  /** A component holds at most one key with this prefix (accounts: `iban:`, review N2). */
  readonly exclusivePrefix?: string;
  /** Claims the event makes, after the kind's acceptance rules (e.g. the IBAN checksum). */
  claims(e: FoldEvent): readonly IdentityClaim[];
  merges(e: FoldEvent): readonly { source: string; target: string }[];
  /** Public tables the kind writes (conflicts shown to the owner). */
  readonly tables?: readonly TableDef[];
  writeConflicts?(conflicts: readonly IdentityConflict[], sql: ViewSql): void;
}
