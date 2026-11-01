// `SqlDriver` (`@cashu/store`) over `node:sqlite` for Node hosts: no native module, so the same code
// runs under plain Node and Electron's utility process. Synchronous like every SqlDriver; statements
// are prepared once per SQL text. Integers come back as JS numbers (as better-sqlite3 returns them);
// `node:sqlite` throws on an integer beyond 2^53 instead of rounding it.
//
// `readOnly: true` opens the file read-only (SQLite refuses any write) and the driver refuses `exec`
// and statement `run` up front. This is how a host reads Python's live WAL database: each
// `transaction(fn)` is one short read transaction (one consistent snapshot, ended when `fn` returns,
// so WAL checkpoints are never starved); reads outside a transaction see the latest commit each.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDriver, SqlRunResult, SqlStatement, SqlValue } from "@cashu/store";
import type { HostLock } from "./host/lock.js";

export interface NodeSqliteOptions {
  /** Open the file read-only and refuse writes (default false: open or create read-write). */
  readonly readOnly?: boolean;
  /**
   * Open as the data dir's single writer (the host's vault and device DBs): `locking_mode=EXCLUSIVE`
   * before the first access and the file lock taken at once, so any other process opening the file
   * gets "database is locked" instead of forking a device stream. In WAL mode no shared memory is
   * used. Requires the held host lock, which only `acquireHostLock` returns.
   */
  readonly exclusive?: HostLock;
}

/** An exclusive open without the held host lock, or combined with `readOnly`. */
export class ExclusiveOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExclusiveOpenError";
  }
}

/** A write through a driver opened `readOnly`. */
export class ReadOnlyDriverError extends Error {
  constructor(what: "exec" | "run") {
    super(`${what} refused: this driver was opened read-only`);
    this.name = "ReadOnlyDriverError";
  }
}

/** Open (or, read-write, create) a database file, or `":memory:"`. `close()` closes it. */
export function openNodeSqlite(path: string, options: NodeSqliteOptions = {}): SqlDriver {
  const readOnly = options.readOnly ?? false;
  if (options.exclusive !== undefined) {
    if (readOnly) throw new ExclusiveOpenError("an exclusive open is a writer, not read-only");
    if (!options.exclusive.held) throw new ExclusiveOpenError("the host lock is not held");
  }
  const db = new DatabaseSync(path, { readOnly });
  if (options.exclusive !== undefined) {
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("PRAGMA locking_mode = EXCLUSIVE");
      // A write transaction takes the exclusive file lock, which exclusive mode then keeps.
      db.exec("BEGIN IMMEDIATE; COMMIT");
    } catch (error) {
      db.close();
      throw error;
    }
  }
  const statements = new Map<string, SqlStatement>();
  let depth = 0;
  const wrap = (stmt: StatementSync): SqlStatement => ({
    run(...params: SqlValue[]): SqlRunResult {
      if (readOnly) throw new ReadOnlyDriverError("run");
      const r = stmt.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get<R>(...params: SqlValue[]) {
      return stmt.get(...params) as R | undefined;
    },
    all<R>(...params: SqlValue[]) {
      return stmt.all(...params) as R[];
    },
  });
  return {
    exec(sql) {
      if (readOnly) throw new ReadOnlyDriverError("exec");
      db.exec(sql);
    },
    prepare(sql) {
      let stmt = statements.get(sql);
      if (stmt === undefined) {
        stmt = wrap(db.prepare(sql));
        statements.set(sql, stmt);
      }
      return stmt;
    },
    transaction<T>(fn: () => T): T {
      // Nested calls are savepoints; on a read-only connection they only scope the snapshot.
      const savepoint = `sp${depth}`;
      db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        db.exec(depth === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        depth -= 1;
        db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        throw error;
      }
    },
    close() {
      statements.clear();
      db.close();
    },
  };
}
