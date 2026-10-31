// The SQLite seam (spike-result.md `SqlDriver`). Every runtime passes an opened database through an
// adapter: better-sqlite3 in the Electron utility process and the CLI, expo-sqlite on the phone. The
// API is synchronous on purpose: a batch is folded inside one SQLite transaction, and expo-sqlite's
// sync API (`withTransactionSync`) and better-sqlite3 both allow that without awaiting mid-transaction.

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface SqlStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get<R = SqlRow>(...params: SqlValue[]): R | undefined;
  all<R = SqlRow>(...params: SqlValue[]): R[];
}

export interface SqlDriver {
  /** Run one or more statements without results (DDL, pragmas). */
  exec(sql: string): void;
  /** Prepare a statement. Callers cache statements; adapters may cache too. */
  prepare(sql: string): SqlStatement;
  /** Run `fn` in a transaction (nested calls use savepoints); rolled back when `fn` throws. */
  transaction<T>(fn: () => T): T;
  close(): void;
}
