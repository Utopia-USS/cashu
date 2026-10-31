/// <reference types="node" />
/**
 * A read-only `SqlDriver` (`@cashu/store`) over a `node:sqlite` connection opened with
 * `readOnly: true`, for code that takes a driver (the genesis source reader) and must only ever
 * read the parity run copy of a Python database.
 *
 * - `exec` and statement `run` are refused (`ReadOnlyDriverError`); the connection itself is
 *   read-only too, so a write slipped through `get` / `all` fails in SQLite.
 * - `transaction(fn)` is a plain call: there is nothing to commit or roll back.
 * - Statements are prepared once per SQL text and reused.
 * - Integers come back as JS numbers, as better-sqlite3 returns them; `node:sqlite` throws on an
 *   integer beyond 2^53 instead of rounding it.
 */

import { DatabaseSync } from "node:sqlite";
import type { SqlDriver, SqlStatement, SqlValue } from "@cashu/store";

export class ReadOnlyDriverError extends Error {
  constructor(what: string) {
    super(`${what} refused: this driver only reads the parity copy`);
    this.name = "ReadOnlyDriverError";
  }
}

/** Open `path` read-only and wrap it. `close()` closes the connection. */
export function openReadOnlyDriver(path: string): SqlDriver {
  const db = new DatabaseSync(path, { readOnly: true });
  const statements = new Map<string, SqlStatement>();
  return {
    exec() {
      throw new ReadOnlyDriverError("exec");
    },
    prepare(sql) {
      const cached = statements.get(sql);
      if (cached !== undefined) return cached;
      const stmt = db.prepare(sql);
      const wrapped: SqlStatement = {
        run() {
          throw new ReadOnlyDriverError("run");
        },
        get<R>(...params: SqlValue[]) {
          return stmt.get(...params) as R | undefined;
        },
        all<R>(...params: SqlValue[]) {
          return stmt.all(...params) as R[];
        },
      };
      statements.set(sql, wrapped);
      return wrapped;
    },
    transaction<T>(fn: () => T): T {
      return fn();
    },
    close() {
      statements.clear();
      db.close();
    },
  };
}
