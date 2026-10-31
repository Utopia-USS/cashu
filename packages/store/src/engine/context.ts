// The FoldContext implementation: SQL with per-table write tracking and a statement cache, the
// view id allocator, the partition index and identity lookups.
import type { DetGid } from "../gid.js";
import type { SqlDriver, SqlStatement, SqlValue } from "../sql/driver.js";
import { viewTimestamp } from "../sql/values.js";
import type { IdentityService } from "./identity.js";
import type { FoldContext, FoldEvent, FoldMembers, ViewSql } from "./types.js";

export class StatementCache {
  readonly #db: SqlDriver;
  readonly #cache = new Map<string, SqlStatement>();

  constructor(db: SqlDriver) {
    this.#db = db;
  }

  get(sql: string): SqlStatement {
    let s = this.#cache.get(sql);
    if (!s) {
      s = this.#db.prepare(sql);
      this.#cache.set(sql, s);
    }
    return s;
  }

  /** Run DDL (index drops and builds of a full re-fold). */
  exec(sql: string): void {
    this.#db.exec(sql);
  }
}

/** Collects the public tables written during one apply (the useQuery invalidation set). */
export class TouchedTables {
  readonly #internal: ReadonlySet<string>;
  readonly set = new Set<string>();

  constructor(internal: ReadonlySet<string>) {
    this.#internal = internal;
  }

  add(table: string): void {
    if (!this.#internal.has(table)) this.set.add(table);
  }
}

export function viewSql(stmts: StatementCache, touched: TouchedTables): ViewSql {
  return {
    write(table, sql, ...params) {
      const r = stmts.get(sql).run(...params);
      if (r.changes > 0) touched.add(table);
      return r;
    },
    get<R>(sql: string, ...params: SqlValue[]) {
      return stmts.get(sql).get<R>(...params);
    },
    all<R>(sql: string, ...params: SqlValue[]) {
      return stmts.get(sql).all<R>(...params);
    },
  };
}

export class ViewIds {
  readonly #stmts: StatementCache;
  readonly #cache = new Map<string, number>();

  constructor(stmts: StatementCache) {
    this.#stmts = stmts;
  }

  id(gid: string): number {
    const hit = this.#cache.get(gid);
    if (hit !== undefined) return hit;
    const inserted = this.#stmts
      .get("INSERT INTO view_ids (gid) VALUES (?) ON CONFLICT (gid) DO NOTHING RETURNING id")
      .get<{ id: number }>(gid);
    const id =
      inserted?.id ??
      (
        this.#stmts.get("SELECT id FROM view_ids WHERE gid = ?").get<{ id: number }>(gid) as {
          id: number;
        }
      ).id;
    this.#cache.set(gid, id);
    return id;
  }

  reset(): void {
    this.#cache.clear();
  }
}

export function foldMembers(
  stmts: StatementCache,
  table: string,
): FoldMembers & {
  clear(partitions: readonly string[]): void;
  clearAll(): void;
} {
  return {
    add(partition, subject, role) {
      stmts
        .get(
          `INSERT INTO ${table} (subject, partition, role) VALUES (?, ?, ?)
           ON CONFLICT (subject, partition) DO UPDATE SET role = excluded.role`,
        )
        .run(subject, partition, role ?? null);
    },
    partitionsOf(subject) {
      return stmts
        .get(`SELECT partition FROM ${table} WHERE subject = ?`)
        .all<{ partition: string }>(subject)
        .map((r) => r.partition);
    },
    roleOf(subject, partition) {
      return (
        stmts
          .get(`SELECT role FROM ${table} WHERE subject = ? AND partition = ?`)
          .get<{ role: string | null }>(subject, partition)?.role ?? null
      );
    },
    subjectsOf(partition) {
      return stmts
        .get(`SELECT subject, role FROM ${table} WHERE partition = ?`)
        .all<{ subject: string; role: string | null }>(partition);
    },
    clear(partitions) {
      const del = stmts.get(`DELETE FROM ${table} WHERE partition = ?`);
      for (const p of partitions) del.run(p);
    },
    clearAll() {
      stmts.get(`DELETE FROM ${table}`).run();
    },
  };
}

function domainTime(e: FoldEvent, column: string, explicit?: string | null): string {
  const stamps = e.data.stamps as Record<string, string | null> | undefined;
  const stamped = stamps?.[column];
  return viewTimestamp(stamped ?? explicit ?? e.at);
}

export function foldContext(args: {
  vault: string;
  sql: ViewSql;
  members: FoldMembers;
  ids: ViewIds;
  identity: IdentityService;
  det: DetGid;
  referrers: (subject: string) => readonly string[];
  keyedEvent: (gid: string, type: string) => FoldEvent | undefined;
}): FoldContext {
  const { ids, identity } = args;
  return {
    vault: args.vault,
    sql: args.sql,
    members: args.members,
    det: args.det,
    id: (gid) => ids.id(gid),
    resolve: (kind, gid) => identity.resolve(kind, gid),
    identityMembers: (kind, root) => identity.members(kind, root),
    accepted: (kind, eid) => identity.accepted(kind, eid),
    referrers: args.referrers,
    keyedEvent: args.keyedEvent,
    time: domainTime,
  };
}
