/// <reference types="node" />
// SqlDriver over node:sqlite (layers.md "Platform code"). The Electron utility process runs Electron's
// own Node, so node:sqlite needs no native module built against Electron's ABI (better-sqlite3 would).
// Synchronous like every SqlDriver: a batch folds inside one transaction; nested transactions are
// savepoints.
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SqlDriver, SqlRunResult, SqlStatement, SqlValue } from "@cashu/store";

/** Open (or create) a database file, or `":memory:"`. */
export function openNodeSqlite(path: string): SqlDriver {
  const db = new DatabaseSync(path);
  const statements = new Map<string, StatementSync>();
  let depth = 0;
  const prepared = (sql: string): StatementSync => {
    let stmt = statements.get(sql);
    if (stmt === undefined) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql): SqlStatement {
      const stmt = prepared(sql);
      return {
        run(...params: SqlValue[]): SqlRunResult {
          const r = stmt.run(...params);
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        },
        get<R>(...params: SqlValue[]) {
          return stmt.get(...params) as R | undefined;
        },
        all<R>(...params: SqlValue[]) {
          return stmt.all(...params) as R[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
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
