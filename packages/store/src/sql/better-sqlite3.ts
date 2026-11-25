// better-sqlite3 adapter (Electron utility process, CLI, tests). Structural: the app opens the
// database (`new Database(path)`) and passes it in, so packages/store carries no native dependency
// and stays importable on Hermes.
import type { SqlDriver, SqlRunResult, SqlStatement, SqlValue } from "./driver.js";

/** The part of better-sqlite3's `Database` the adapter uses. */
export interface BetterSqlite3Database {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
  close(): unknown;
}

export function betterSqlite3Driver(db: BetterSqlite3Database): SqlDriver {
  return {
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql): SqlStatement {
      const stmt = db.prepare(sql);
      return {
        run(...params: SqlValue[]): SqlRunResult {
          const r = stmt.run(...params);
          return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
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
      return db.transaction(fn)();
    },
    close() {
      db.close();
    },
  };
}
