// expo-sqlite adapter (phone). Structural over expo-sqlite's synchronous API (`openDatabaseSync`,
// `execSync`, `prepareSync`, `withTransactionSync`), which the spike ran on Hermes in Expo Go
// (spike-result.md, iOS smoke). The app opens the database and passes it in; packages/store never
// imports expo. Not yet run on a device: S41 wires it in the mobile scaffold and runs the store
// suite on the simulator.
import type { SqlDriver, SqlRunResult, SqlStatement, SqlValue } from "./driver.js";

interface ExpoExecuteResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
  getFirstSync(): unknown;
  getAllSync(): unknown[];
}

interface ExpoStatement {
  executeSync(params: SqlValue[]): ExpoExecuteResult;
  finalizeSync(): void;
}

/** The part of expo-sqlite's `SQLiteDatabase` the adapter uses. */
export interface ExpoSqliteDatabase {
  execSync(sql: string): void;
  prepareSync(sql: string): ExpoStatement;
  withTransactionSync(task: () => void): void;
  closeSync(): void;
}

export function expoSqliteDriver(db: ExpoSqliteDatabase): SqlDriver {
  const statements: ExpoStatement[] = [];
  let depth = 0;
  return {
    exec(sql) {
      db.execSync(sql);
    },
    prepare(sql): SqlStatement {
      const stmt = db.prepareSync(sql);
      statements.push(stmt);
      return {
        run(...params: SqlValue[]): SqlRunResult {
          const r = stmt.executeSync(params);
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowId };
        },
        get<R>(...params: SqlValue[]) {
          return (stmt.executeSync(params).getFirstSync() ?? undefined) as R | undefined;
        },
        all<R>(...params: SqlValue[]) {
          return stmt.executeSync(params).getAllSync() as R[];
        },
      };
    },
    transaction<T>(fn: () => T): T {
      // withTransactionSync does not nest: inner calls use a savepoint like better-sqlite3 does.
      if (depth > 0) {
        const name = `sp${depth}`;
        db.execSync(`SAVEPOINT ${name}`);
        depth += 1;
        try {
          const out = fn();
          db.execSync(`RELEASE ${name}`);
          return out;
        } catch (error) {
          db.execSync(`ROLLBACK TO ${name}; RELEASE ${name}`);
          throw error;
        } finally {
          depth -= 1;
        }
      }
      let out: T | undefined;
      depth = 1;
      try {
        db.withTransactionSync(() => {
          out = fn();
        });
      } finally {
        depth = 0;
      }
      return out as T;
    },
    close() {
      for (const s of statements) s.finalizeSync();
      db.closeSync();
    },
  };
}
