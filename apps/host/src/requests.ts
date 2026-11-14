// Idempotent commands: the store channel's `run` carries a key (a ULID the client mints once per
// command). The host records `key -> result` in a device-local table of the same database, in the
// same transaction as the command's events. A client that lost the reply (host crash, dropped socket)
// sends the same `run` again and gets the stored result: a resent command never applies twice.
// Refusals are recorded too (a retry sees the same answer); a command that threw recorded nothing
// (its transaction rolled back), so its retry runs it. Rows older than 24 h are pruned.
//
// The table is not part of the view (no materializer owns it): snapshots, view hashes and rebuilds
// never read or drop it.
import type { JsonValue } from "@cashu/host-protocol/store";
import type { SqlDriver } from "@cashu/store";
import { z } from "zod";

/** What crosses back for a run, as stored: the store channel's `result` payload. */
export type RunResult =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly reason: string };

const runResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.json() }),
  z.object({ ok: z.literal(false), reason: z.string().max(200) }),
]);

export interface StoredRequest {
  readonly command: string;
  readonly result: RunResult;
}

const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;

const DDL = `CREATE TABLE IF NOT EXISTS host_requests (
  key TEXT PRIMARY KEY NOT NULL,
  command TEXT NOT NULL,
  result TEXT NOT NULL,
  at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS host_requests_at ON host_requests (at);`;

export class RequestTable {
  readonly #driver: SqlDriver;
  readonly #now: () => number;

  constructor(driver: SqlDriver, now: () => number = Date.now) {
    this.#driver = driver;
    this.#now = now;
    driver.exec(DDL);
  }

  lookup(key: string): StoredRequest | undefined {
    const row = this.#driver
      .prepare("SELECT command, result FROM host_requests WHERE key = ?")
      .get<{ command: string; result: string }>(key);
    if (row === undefined) return undefined;
    return { command: row.command, result: runResultSchema.parse(JSON.parse(row.result)) };
  }

  /** Records a key; must run inside the transaction that applies the command's events. */
  record(key: string, command: string, result: RunResult): void {
    this.#driver
      .prepare("INSERT INTO host_requests (key, command, result, at) VALUES (?, ?, ?, ?)")
      .run(key, command, JSON.stringify(result), this.#now());
  }

  /** Deletes keys older than the TTL; returns how many. */
  prune(): number {
    return this.#driver
      .prepare("DELETE FROM host_requests WHERE at < ?")
      .run(this.#now() - REQUEST_TTL_MS).changes;
  }
}
