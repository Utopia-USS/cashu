// expo-sqlite adapter (phone). Structural over expo-sqlite's synchronous API (`openDatabaseSync`,
// `execSync`, `prepareSync`, `withTransactionSync`); the app opens the database and passes it in, so
// packages/store never imports expo. Checked against expo-sqlite 58 (SDK 58): `executeSync` resets and
// rebinds the statement and steps it once; a row read leaves the cursor on that row until the next
// run, so `get` resets it (no read left open on the connection). Run on the iOS simulator by S41
// (apps/mobile debug screen: the demo log builds the same view hash as better-sqlite3 on Node).
import type { SqlDriver, SqlRunResult, SqlStatement, SqlValue } from "./driver.js";

interface ExpoExecuteResult {
  readonly changes: number;
  readonly lastInsertRowId: number;
  getFirstSync(): unknown;
  getAllSync(): unknown[];
  resetSync(): void;
}

/** What expo-sqlite 58's typings accept as a bind value (`SQLiteBindValue`). */
type ExpoBindValue = string | number | boolean | null | Uint8Array;

interface ExpoStatement {
  executeSync(params: ExpoBindValue[]): ExpoExecuteResult;
  finalizeSync(): void;
}

/**
 * expo-sqlite's typings omit `bigint`, while its native binding takes one as a 64-bit integer
 * (ios/SQLiteBindValue.swift). A safe integer goes as a number (what the typings promise); a larger
 * one keeps the bigint so no precision is lost.
 */
function bindValue(v: SqlValue): ExpoBindValue {
  if (typeof v !== "bigint") return v;
  if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER))
    return Number(v);
  return v as unknown as ExpoBindValue;
}
const bind = (params: SqlValue[]): ExpoBindValue[] => params.map(bindValue);

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
          const r = stmt.executeSync(bind(params));
          return { changes: r.changes, lastInsertRowid: r.lastInsertRowId };
        },
        get<R>(...params: SqlValue[]) {
          const r = stmt.executeSync(bind(params));
          try {
            return (r.getFirstSync() ?? undefined) as R | undefined;
          } finally {
            r.resetSync();
          }
        },
        all<R>(...params: SqlValue[]) {
          return stmt.executeSync(bind(params)).getAllSync() as R[];
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
