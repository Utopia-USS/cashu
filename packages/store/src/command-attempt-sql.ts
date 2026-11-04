// Private, nonreplaceable metadata. A view rebuild never removes keyed attempts.
import type { AttemptLookup, AttemptRecord, CommandAttemptPort } from "./command-durable.js";
import type { SqlDriver } from "./sql/driver.js";

const TTL_MS = 24 * 60 * 60 * 1000;
export type CommandAttemptTable = "host_attempts" | "mobile_attempts";
const DDL = (table: CommandAttemptTable) => `CREATE TABLE ${table} (
  key TEXT PRIMARY KEY NOT NULL, vault TEXT NOT NULL, attempt_id TEXT UNIQUE NOT NULL,
  command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, phase TEXT NOT NULL,
  eids TEXT NOT NULL, digest TEXT, terminal_kind TEXT, terminal_reason TEXT,
  receipt TEXT, completed_at INTEGER
) WITHOUT ROWID;
CREATE INDEX ${table}_completed_at ON ${table}(completed_at);`;

type Row = {
  key: string;
  vault: string;
  attempt_id: string;
  command_id: string;
  fingerprint: string;
  phase: string;
  eids: string;
  digest: string | null;
  terminal_kind: string | null;
  terminal_reason: string | null;
  receipt: string | null;
  completed_at: number | null;
};

function decode<R>(row: Row): AttemptLookup<R> {
  const eids: unknown = JSON.parse(row.eids);
  if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string"))
    throw new Error("corrupt_attempt");
  const base = { attemptId: row.attempt_id, fingerprint: row.fingerprint };
  if (row.phase === "may_append")
    return {
      phase: "may_append",
      ...base,
      eids,
      ...(row.digest === null ? {} : { digest: row.digest }),
    };
  if (row.phase === "completed")
    return {
      phase: "completed",
      ...base,
      eids,
      ...(row.digest === null ? {} : { digest: row.digest }),
      receipt: row.receipt === null ? undefined : { value: JSON.parse(row.receipt) as R },
    };
  if (
    row.phase === "terminal" &&
    (row.terminal_kind === "refused" || row.terminal_kind === "not_started") &&
    row.terminal_reason !== null
  )
    return {
      phase: "terminal",
      ...base,
      result: { kind: row.terminal_kind, reason: row.terminal_reason },
    };
  throw new Error("corrupt_attempt");
}

/** The caller opens the private DB under its OS lease. The table name is a closed enum. */
export class SqlCommandAttemptJournal<R> implements CommandAttemptPort<R> {
  readonly #driver: SqlDriver;
  readonly #now: () => number;
  readonly #table: CommandAttemptTable;

  private constructor(driver: SqlDriver, table: CommandAttemptTable, now: () => number) {
    this.#driver = driver;
    this.#table = table;
    this.#now = now;
  }

  static open<R>(
    driver: SqlDriver,
    mode: "existing" | "new",
    table: CommandAttemptTable,
    now: () => number = Date.now,
  ): SqlCommandAttemptJournal<R> {
    const lookup = driver.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?");
    const exists = lookup.get(table) !== undefined;
    if (mode === "existing" && !exists) throw new Error("missing_attempt_journal");
    if (mode === "new" && exists) throw new Error("attempt_journal_exists");
    if (mode === "new") driver.exec(DDL(table));
    if (mode === "existing") {
      const columns = driver.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
      const expected = [
        "key",
        "vault",
        "attempt_id",
        "command_id",
        "fingerprint",
        "phase",
        "eids",
        "digest",
        "terminal_kind",
        "terminal_reason",
        "receipt",
        "completed_at",
      ];
      if (columns.map((column) => column.name).join("|") !== expected.join("|"))
        throw new Error("attempt_journal_schema_mismatch");
    }
    return new SqlCommandAttemptJournal<R>(driver, table, now);
  }

  #row(vault: string, key: string): Row | undefined {
    const row = this.#driver.prepare(`SELECT * FROM ${this.#table} WHERE key = ?`).get<Row>(key);
    if (row !== undefined && row.vault !== vault) throw new Error("request_key_conflict");
    return row;
  }

  async lookup(vault: string, key: string): Promise<AttemptLookup<R>> {
    const row = this.#row(vault, key);
    return row === undefined ? { phase: "absent" } : decode<R>(row);
  }

  /** Read-only key status; never prepares, writes, or regenerates an input. */
  status(vault: string, key: string, commandId: string): AttemptLookup<R> {
    const row = this.#row(vault, key);
    if (row === undefined) return { phase: "absent" };
    if (row.command_id !== commandId) throw new Error("request_key_conflict");
    return decode<R>(row);
  }

  async saveMayAppend(
    record: AttemptRecord & { readonly eids: readonly string[]; readonly digest?: string },
  ): Promise<AttemptLookup<R>> {
    if (
      record.eids.length > 0 &&
      (record.digest === undefined || !/^[0-9a-f]{64}$/.test(record.digest))
    )
      throw new Error("attempt_digest_required");
    this.#driver
      .prepare(`INSERT OR IGNORE INTO ${this.#table}
      (key,vault,attempt_id,command_id,fingerprint,phase,eids,digest)
      VALUES (?,?,?,?,?,'may_append',?,?)`)
      .run(
        record.key,
        record.vault,
        record.attemptId,
        record.commandId,
        record.fingerprint,
        JSON.stringify(record.eids),
        record.digest ?? null,
      );
    return this.lookup(record.vault, record.key);
  }

  async markCompleted(attemptId: string, receipt: R): Promise<void> {
    const result = this.#driver
      .prepare(`UPDATE ${this.#table}
      SET phase='completed', receipt=?, completed_at=?
      WHERE attempt_id=? AND phase='may_append'`)
      .run(JSON.stringify(receipt), this.#now(), attemptId);
    if (result.changes !== 1) throw new Error("attempt_not_pending");
  }

  /** Exact authenticated batch committed but the original result receipt is unavailable. */
  async markCommittedWithoutReceipt(attemptId: string): Promise<void> {
    const result = this.#driver
      .prepare(`UPDATE ${this.#table}
        SET phase='completed', receipt=NULL, completed_at=?
        WHERE attempt_id=? AND phase='may_append'`)
      .run(this.#now(), attemptId);
    if (result.changes !== 1) throw new Error("attempt_not_pending");
  }

  /** Only after a complete authenticated own-tail inspection proves the batch absent. */
  async markNotStarted(attemptId: string): Promise<void> {
    const result = this.#driver
      .prepare(`UPDATE ${this.#table}
        SET phase='terminal', terminal_kind='not_started',
          terminal_reason='authenticated_batch_absent'
        WHERE attempt_id=? AND phase='may_append'`)
      .run(attemptId);
    if (result.changes !== 1) throw new Error("attempt_not_pending");
  }

  async recordTerminal(
    record: AttemptRecord & {
      readonly result: { readonly kind: "refused" | "not_started"; readonly reason: string };
    },
  ): Promise<AttemptLookup<R>> {
    this.#driver
      .prepare(`INSERT OR IGNORE INTO ${this.#table}
      (key,vault,attempt_id,command_id,fingerprint,phase,eids,terminal_kind,terminal_reason)
      VALUES (?,?,?,?,?,'terminal','[]',?,?)`)
      .run(
        record.key,
        record.vault,
        record.attemptId,
        record.commandId,
        record.fingerprint,
        record.result.kind,
        record.result.reason,
      );
    return this.lookup(record.vault, record.key);
  }

  async unresolved(
    vault: string,
  ): Promise<
    readonly (AttemptRecord & { readonly eids: readonly string[]; readonly digest?: string })[]
  > {
    return this.#driver
      .prepare(`SELECT * FROM ${this.#table} WHERE vault=? AND phase='may_append'`)
      .all<Row>(vault)
      .map((row) => {
        const decoded = decode<R>(row);
        if (decoded.phase !== "may_append") throw new Error("corrupt_attempt");
        return {
          vault: row.vault,
          key: row.key,
          attemptId: row.attempt_id,
          commandId: row.command_id,
          fingerprint: row.fingerprint,
          eids: decoded.eids,
          ...(row.digest === null ? {} : { digest: row.digest }),
        };
      });
  }

  /** Bounded public operation handles for UI reattachment; never exposes proof, EIDs or keys. */
  recentOperations(
    vault: string,
    commandId: string,
  ): readonly { readonly operationId: string; readonly phase: "may_append" | "completed" }[] {
    const rows = this.#driver
      .prepare(`SELECT attempt_id, phase FROM ${this.#table}
        WHERE vault=? AND command_id=? AND
          (phase='may_append' OR (phase='completed' AND completed_at>=?))
        ORDER BY attempt_id DESC LIMIT 16`)
      .all<{ attempt_id: string; phase: string }>(vault, commandId, this.#now() - TTL_MS);
    return rows.map((row) => {
      if (row.phase !== "may_append" && row.phase !== "completed")
        throw new Error("corrupt_attempt");
      return { operationId: row.attempt_id, phase: row.phase };
    });
  }

  /** A keyed revoke must be reconciled before any new side effect in this vault. */
  hasPending(vault: string, commandId: string): boolean {
    const row = this.#driver
      .prepare(
        `SELECT COUNT(*) AS count FROM ${this.#table} WHERE vault=? AND command_id=? AND phase='may_append'`,
      )
      .get<{ count: number }>(vault, commandId);
    return (row?.count ?? 0) > 0;
  }

  /** Only the response body expires. The key, binding, phase and EIDs stay forever. */
  pruneReceipts(): number {
    return this.#driver
      .prepare(
        `UPDATE ${this.#table} SET receipt=NULL WHERE phase='completed' AND completed_at < ?`,
      )
      .run(this.#now() - TTL_MS).changes;
  }
}
