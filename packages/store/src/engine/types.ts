// Contracts between the fold engine and the module materializers.
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
export interface ViewSql {
  write(table: string, sql: string, ...params: SqlValue[]): SqlRunResult;
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
   * The gid an event of this type must carry when it is deterministic from the payload (gid.md 4:
   * `DET(table)[parts]`). An event whose gid differs is parked (`invalid-gid`): one gid never
   * stands for two row keys.
   */
  gidOf?(e: FoldEvent, det: DetGid): string | undefined;
  /** Delete the rows (public and internal) of these partitions. */
  clear(partitions: readonly string[], ctx: FoldContext): void;
  apply(e: FoldEvent, ctx: FoldContext): void;
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
