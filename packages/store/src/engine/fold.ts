// Running materializers: incremental apply, partition re-fold and full re-fold (events.md 6.1).
//
// - Fast path: every new event of the materializer sorts after the highest event it has folded
//   (its high-water mark), so applying them in order equals folding the whole set.
// - Partition re-fold: an event that sorts before already-folded ones, or whose applied state
//   flipped (causal suppression), re-folds only the partitions (row keys) it affects. The set is
//   closed over shared events (an event in two partitions pulls both in) and over subjects (the gids
//   events address, from the members table and `event_refs`), then cleared and replayed in order.
// - Full re-fold: identity roots changed (rows re-key), the view version changed, or a rebuild.

import type { DetGid } from "../gid.js";
import { bulkIndexes, createIndexSql, indexName, type TableDef } from "../sql/ddl.js";
import { foldContext, foldMembers, type StatementCache, type ViewIds } from "./context.js";
import type { DirtyCollector } from "./derive.js";
import type { IdentityService } from "./identity.js";
import type { EventLog } from "./log.js";
import {
  compareOrd,
  type FoldContext,
  type FoldEvent,
  type Materializer,
  ord,
  type ViewSql,
} from "./types.js";

/**
 * The partition index of one materializer (FoldMembers): its own table, so a full re-fold truncates
 * it and the keys carry no materializer column.
 */
export function membersTable(mat: { readonly id: string }): TableDef {
  return {
    name: `members_${mat.id.replace(/\./g, "_")}`,
    primaryKey: ["subject", "partition"],
    withoutRowid: true,
    internal: true,
    columns: [
      { name: "subject", type: "TEXT", notNull: true },
      { name: "partition", type: "TEXT", notNull: true },
      { name: "role", type: "TEXT" },
    ],
    indexes: [{ columns: ["partition"] }],
  };
}

/**
 * The refs index of `refsOnDemand` materializers (events.md 6.6 does not depend on it; it only finds
 * the event a derived gid belongs to, e.g. a cash leg's import): caught up from the log position it
 * last indexed, when `referrers` is asked. A rebuild that re-indexes refs resets it.
 */
export class LazyRefs {
  static readonly KEY = "lazy_refs_seq";
  readonly #log: EventLog;
  readonly #stmts: StatementCache;
  readonly #det: DetGid;
  readonly #byType = new Map<string, Materializer[]>();
  #seq: number;

  constructor(log: EventLog, stmts: StatementCache, det: DetGid, mats: readonly Materializer[]) {
    this.#log = log;
    this.#stmts = stmts;
    this.#det = det;
    for (const m of mats.filter((x) => x.refsOnDemand === true && x.refs !== undefined)) {
      for (const t of m.handles) this.#byType.set(t, [...(this.#byType.get(t) ?? []), m]);
    }
    this.#seq = Number(
      stmts.get("SELECT value FROM store_meta WHERE key = ?").get<{ value: string }>(LazyRefs.KEY)
        ?.value ?? 0,
    );
  }

  /** Index the refs of every event stored since the last call. */
  catchUp(): void {
    if (this.#byType.size === 0) return;
    const last = this.#log.lastSeq();
    if (last <= this.#seq) return;
    const refs: [string, string][] = [];
    for (const e of this.#log.heldAfter([...this.#byType.keys()], this.#seq)) {
      for (const m of this.#byType.get(e.type) ?? []) {
        for (const s of m.refs?.(e, this.#det) ?? []) refs.push([s, e.eid]);
      }
    }
    this.#log.addRefs(refs);
    this.#setSeq(last);
  }

  /** Forget the index position (the refs were dropped: a re-index or a reset). */
  reset(): void {
    this.#setSeq(0);
  }

  #setSeq(seq: number): void {
    this.#seq = seq;
    this.#stmts
      .get(
        "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(LazyRefs.KEY, String(seq));
  }
}

export interface FoldDeps {
  readonly vault: string;
  readonly log: EventLog;
  readonly lazyRefs: LazyRefs;
  readonly stmts: StatementCache;
  readonly ids: ViewIds;
  readonly identity: IdentityService;
  readonly det: DetGid;
}

/** Events between two progress reports of a full re-fold. */
const FOLD_TICK = 4096;

export class MaterializerRunner {
  readonly mat: Materializer;
  readonly #deps: FoldDeps;
  readonly #members: ReturnType<typeof foldMembers>;
  #hwm: string;
  /**
   * Record the partitions this runner folds (a deriver inputs it): set by the store when its module
   * registry has a deriver listing this materializer. Off, the runner does no extra work.
   */
  track = false;

  constructor(mat: Materializer, deps: FoldDeps) {
    this.mat = mat;
    this.#deps = deps;
    this.#members = foldMembers(deps.stmts, membersTable(mat).name);
    this.#hwm =
      deps.stmts.get("SELECT hwm FROM materializer_state WHERE id = ?").get<{ hwm: string }>(mat.id)
        ?.hwm ?? "";
  }

  #ctx(sql: ViewSql): FoldContext {
    const d = this.#deps;
    return foldContext({
      vault: d.vault,
      sql,
      members: this.#members,
      ids: d.ids,
      identity: d.identity,
      det: d.det,
      referrers: (subject) => {
        d.lazyRefs.catchUp();
        return d.log.referrers(subject);
      },
      keyedEvent: (gid, type) => d.log.keyedEvent(gid, type),
    });
  }

  #setHwm(value: string): void {
    if (value === this.#hwm) return;
    this.#hwm = value;
    this.#deps.stmts
      .get(
        "INSERT INTO materializer_state (id, hwm) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET hwm = excluded.hwm",
      )
      .run(this.mat.id, value);
  }

  /** True when every event sorts after everything this materializer has folded. */
  canAppend(events: readonly FoldEvent[]): boolean {
    return events.every((e) => ord(e) > this.#hwm);
  }

  /** Apply events that all sort after the high-water mark. */
  append(events: readonly FoldEvent[], sql: ViewSql, dirty?: DirtyCollector): void {
    const ctx = this.#ctx(sql);
    const sorted = [...events].sort(compareOrd);
    const record = this.track && dirty !== undefined;
    for (const e of sorted) {
      if (record) dirty?.add(this.mat.id, this.mat.partitions(e, ctx));
      this.mat.apply(e, ctx);
    }
    sql.flush();
    const last = sorted[sorted.length - 1];
    if (last) this.#setHwm(ord(last));
  }

  /** Re-fold the partitions affected by `triggers` (new, re-ordered or state-flipped events). */
  refoldPartitions(triggers: readonly FoldEvent[], sql: ViewSql, dirty?: DirtyCollector): void {
    const ctx = this.#ctx(sql);
    const m = this.mat;
    const partitions = new Set<string>();
    const subjects = new Set<string>();
    const events = new Map<string, FoldEvent>();
    const expanded = new Set<string>();
    const queried = new Set<string>();

    const addSubjects = (e: FoldEvent) => {
      subjects.add(e.gid);
      for (const r of m.refs?.(e, this.#deps.det) ?? []) subjects.add(r);
    };
    for (const t of triggers) {
      addSubjects(t);
      for (const p of m.partitions(t, ctx)) partitions.add(p);
    }
    for (;;) {
      for (const p of partitions) {
        if (expanded.has(p)) continue;
        expanded.add(p);
        for (const s of this.#members.subjectsOf(p)) subjects.add(s.subject);
        for (const s of m.subjects?.(p, ctx) ?? []) subjects.add(s);
      }
      const fresh = [...subjects].filter((s) => !queried.has(s));
      if (fresh.length === 0) break;
      for (const s of fresh) queried.add(s);
      for (const e of this.#deps.log.appliedForSubjects(m.handles, fresh)) {
        if (events.has(e.eid)) continue;
        events.set(e.eid, e);
        addSubjects(e);
        for (const p of m.partitions(e, ctx)) partitions.add(p);
      }
    }
    const list = [...partitions];
    if (this.track) dirty?.add(m.id, list);
    m.clear(list, ctx);
    this.#members.clear(list);
    const sorted = [...events.values()].sort(compareOrd);
    for (const e of sorted) m.apply(e, ctx);
    sql.flush();
    const last = sorted[sorted.length - 1];
    if (last && ord(last) > this.#hwm) this.#setHwm(ord(last));
  }

  /**
   * Clear every table of the materializer and fold all its applied events again. Plain secondary
   * indexes are dropped for the fold and built again after it (inside the same transaction, so no
   * reader sees a table without them).
   */
  refoldAll(
    sql: ViewSql,
    dirty?: DirtyCollector,
    onFold?: (folded: number, total: number) => void,
  ): void {
    if (this.track) dirty?.all(this.mat.id);
    const ctx = this.#ctx(sql);
    const stmts = this.#deps.stmts;
    const bulk = this.mat.tables.flatMap((t) => bulkIndexes(t).map((ix) => ({ t, ix })));
    // DELETE without WHERE is SQLite's truncate: cheap even for 60k rows.
    for (const t of this.mat.tables) ctx.sql.write(t.name, `DELETE FROM ${t.name}`);
    for (const { t, ix } of bulk) stmts.exec(`DROP INDEX IF EXISTS ${indexName(t, ix)}`);
    this.#members.clearAll();
    const events = this.#deps.log.appliedOfTypes(this.mat.handles);
    if (onFold === undefined) for (const e of events) this.mat.apply(e, ctx);
    else {
      for (const [n, e] of events.entries()) {
        this.mat.apply(e, ctx);
        if ((n + 1) % FOLD_TICK === 0) onFold(n + 1, events.length);
      }
      onFold(events.length, events.length);
    }
    sql.flush();
    for (const { t, ix } of bulk) stmts.exec(createIndexSql(t, ix));
    const last = events[events.length - 1];
    this.#hwm = "";
    this.#setHwm(last ? ord(last) : "");
    if (!last) {
      this.#deps.stmts.get("DELETE FROM materializer_state WHERE id = ?").run(this.mat.id);
    }
  }
}
