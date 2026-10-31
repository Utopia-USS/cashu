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
import type { TableDef } from "../sql/ddl.js";
import { foldContext, foldMembers, type StatementCache, type ViewIds } from "./context.js";
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

export interface FoldDeps {
  readonly vault: string;
  readonly log: EventLog;
  readonly stmts: StatementCache;
  readonly ids: ViewIds;
  readonly identity: IdentityService;
  readonly det: DetGid;
}

export class MaterializerRunner {
  readonly mat: Materializer;
  readonly #deps: FoldDeps;
  readonly #members: ReturnType<typeof foldMembers>;
  #hwm: string;

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
      referrers: (subject) => d.log.referrers(subject),
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
  append(events: readonly FoldEvent[], sql: ViewSql): void {
    const ctx = this.#ctx(sql);
    const sorted = [...events].sort(compareOrd);
    for (const e of sorted) this.mat.apply(e, ctx);
    const last = sorted[sorted.length - 1];
    if (last) this.#setHwm(ord(last));
  }

  /** Re-fold the partitions affected by `triggers` (new, re-ordered or state-flipped events). */
  refoldPartitions(triggers: readonly FoldEvent[], sql: ViewSql): void {
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
    m.clear(list, ctx);
    this.#members.clear(list);
    const sorted = [...events.values()].sort(compareOrd);
    for (const e of sorted) m.apply(e, ctx);
    const last = sorted[sorted.length - 1];
    if (last && ord(last) > this.#hwm) this.#setHwm(ord(last));
  }

  /** Clear every table of the materializer and fold all its applied events again. */
  refoldAll(sql: ViewSql): void {
    const ctx = this.#ctx(sql);
    // DELETE without WHERE is SQLite's truncate: cheap even for 60k rows.
    for (const t of this.mat.tables) ctx.sql.write(t.name, `DELETE FROM ${t.name}`);
    this.#members.clearAll();
    const events = this.#deps.log.appliedOfTypes(this.mat.handles);
    for (const e of events) this.mat.apply(e, ctx);
    const last = events[events.length - 1];
    this.#hwm = "";
    this.#setHwm(last ? ord(last) : "");
    if (!last) {
      this.#deps.stmts.get("DELETE FROM materializer_state WHERE id = ?").run(this.mat.id);
    }
  }
}
