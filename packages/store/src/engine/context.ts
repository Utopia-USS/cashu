// The FoldContext implementation: SQL with per-table write tracking and a statement cache, the
// view id allocator, the partition index and identity lookups.
import type { DetGid } from "../gid.js";
import type { SqlDriver, SqlStatement, SqlValue } from "../sql/driver.js";
import { viewTimestamp } from "../sql/values.js";
import type { IdentityService } from "./identity.js";
import type { FoldContext, FoldEvent, FoldMembers, ViewSql } from "./types.js";

/** Rows per multi-row insert of the queue (18 columns x 64 rows: far below the bound limit). */
const INSERT_BATCH = 64;

/**
 * Queued single-row inserts, run as multi-row statements per statement shape: one per BATCH rows, the
 * remainder row by row. Rows of one statement run in queue order; a second statement shape on a table
 * that already has queued rows flushes first, so the result equals running each insert where it was
 * queued, provided nothing read the tables in between (callers flush before reading).
 */
class InsertQueue {
  readonly #stmts: StatementCache;
  readonly #pending = new Map<
    string,
    { table: string; insert: string; row: string; values: SqlValue[][] }
  >();

  constructor(stmts: StatementCache) {
    this.#stmts = stmts;
  }

  add(table: string, insert: string, row: string, params: SqlValue[], touched?: TouchedTables) {
    const key = `${insert}\u0000${row}`;
    let p = this.#pending.get(key);
    if (p === undefined) {
      for (const q of this.#pending.values()) {
        if (q.table === table) {
          this.flush(touched);
          break;
        }
      }
      p = { table, insert, row, values: [] };
      this.#pending.set(key, p);
    }
    p.values.push(params);
  }

  flush(touched?: TouchedTables): void {
    if (this.#pending.size === 0) return;
    const all = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of all) {
      const rows = p.values;
      let changes = 0;
      let i = 0;
      if (rows.length >= INSERT_BATCH) {
        const many = this.#stmts.get(
          `${p.insert} VALUES ${Array.from({ length: INSERT_BATCH }, () => p.row).join(", ")}`,
        );
        for (; i + INSERT_BATCH <= rows.length; i += INSERT_BATCH) {
          changes += many.run(...rows.slice(i, i + INSERT_BATCH).flat()).changes;
        }
      }
      const one = this.#stmts.get(`${p.insert} VALUES ${p.row}`);
      for (; i < rows.length; i++) changes += one.run(...(rows[i] as SqlValue[])).changes;
      if (changes > 0) touched?.add(p.table);
    }
  }
}

export class StatementCache {
  readonly #db: SqlDriver;
  readonly #cache = new Map<string, SqlStatement>();
  /** The store's insert queue (one per database connection). */
  readonly queue: InsertQueue;

  constructor(db: SqlDriver) {
    this.#db = db;
    this.queue = new InsertQueue(this);
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
  const q = stmts.queue;
  return {
    write(table, sql, ...params) {
      q.flush(touched);
      const r = stmts.get(sql).run(...params);
      if (r.changes > 0) touched.add(table);
      return r;
    },
    insert(table, insert, row, ...params) {
      q.add(table, insert, row, params, touched);
    },
    flush() {
      q.flush(touched);
    },
    get<R>(sql: string, ...params: SqlValue[]) {
      q.flush(touched);
      return stmts.get(sql).get<R>(...params);
    },
    all<R>(sql: string, ...params: SqlValue[]) {
      q.flush(touched);
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

  #next = 0;

  /**
   * The id of `gid`: a known one, or the next free id, its row queued with the fold's inserts (every
   * view row of the gid is written after this call, and view_ids is read only after a fold step).
   */
  id(gid: string): number {
    const hit = this.#cache.get(gid);
    if (hit !== undefined) return hit;
    let id = this.#stmts.get("SELECT id FROM view_ids WHERE gid = ?").get<{ id: number }>(gid)?.id;
    if (id === undefined) {
      if (this.#next === 0) {
        this.#next =
          (this.#stmts.get("SELECT COALESCE(MAX(id), 0) AS id FROM view_ids").get<{ id: number }>()
            ?.id ?? 0) + 1;
      }
      id = this.#next++;
      this.#stmts.queue.add("view_ids", "INSERT INTO view_ids (id, gid)", "(?, ?)", [id, gid]);
    }
    this.#cache.set(gid, id);
    return id;
  }

  reset(): void {
    this.#cache.clear();
    this.#next = 0;
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
