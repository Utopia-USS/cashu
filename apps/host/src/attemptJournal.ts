// Private, nonreplaceable host metadata. A view rebuild never removes keyed attempts.
import type { JsonValue } from "@cashu/host-protocol/store";
import type { AttemptLookup, AttemptRecord, CommandAttemptPort, SqlDriver } from "@cashu/store";

const TTL_MS = 24 * 60 * 60 * 1000;
const DDL = `CREATE TABLE host_attempts (
  key TEXT PRIMARY KEY NOT NULL, vault TEXT NOT NULL, attempt_id TEXT UNIQUE NOT NULL,
  command_id TEXT NOT NULL, fingerprint TEXT NOT NULL, phase TEXT NOT NULL,
  eids TEXT NOT NULL, terminal_kind TEXT, terminal_reason TEXT,
  receipt TEXT, completed_at INTEGER
) WITHOUT ROWID;
CREATE INDEX host_attempts_completed_at ON host_attempts(completed_at);`;

type Row = {
  key: string;
  vault: string;
  attempt_id: string;
  command_id: string;
  fingerprint: string;
  phase: string;
  eids: string;
  terminal_kind: string | null;
  terminal_reason: string | null;
  receipt: string | null;
  completed_at: number | null;
};

function decode(row: Row): AttemptLookup<JsonValue> {
  const eids: unknown = JSON.parse(row.eids);
  if (!Array.isArray(eids) || !eids.every((eid) => typeof eid === "string"))
    throw new Error("corrupt_attempt");
  const base = { attemptId: row.attempt_id, fingerprint: row.fingerprint };
  if (row.phase === "may_append") return { phase: "may_append", ...base, eids };
  if (row.phase === "completed")
    return {
      phase: "completed",
      ...base,
      eids,
      receipt: row.receipt === null ? undefined : { value: JSON.parse(row.receipt) as JsonValue },
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

/** The caller opens this DB under the host lease after checking that the file already exists. */
export class SqlAttemptJournal implements CommandAttemptPort<JsonValue> {
  readonly #driver: SqlDriver;
  readonly #now: () => number;

  private constructor(driver: SqlDriver, now: () => number) {
    this.#driver = driver;
    this.#now = now;
  }

  static open(
    driver: SqlDriver,
    mode: "existing" | "new",
    now: () => number = Date.now,
  ): SqlAttemptJournal {
    const table = driver.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='host_attempts'",
    );
    const exists = table.get() !== undefined;
    if (mode === "existing" && !exists) throw new Error("missing_attempt_journal");
    if (mode === "new" && exists) throw new Error("attempt_journal_exists");
    if (mode === "new") driver.exec(DDL);
    return new SqlAttemptJournal(driver, now);
  }

  #row(vault: string, key: string): Row | undefined {
    const row = this.#driver.prepare("SELECT * FROM host_attempts WHERE key = ?").get<Row>(key);
    if (row !== undefined && row.vault !== vault) throw new Error("request_key_conflict");
    return row;
  }

  async lookup(vault: string, key: string): Promise<AttemptLookup<JsonValue>> {
    const row = this.#row(vault, key);
    return row === undefined ? { phase: "absent" } : decode(row);
  }

  /** Read-only key status; never prepares, writes, or regenerates an input. */
  status(vault: string, key: string, commandId: string): AttemptLookup<JsonValue> {
    const row = this.#row(vault, key);
    if (row === undefined) return { phase: "absent" };
    if (row.command_id !== commandId) throw new Error("request_key_conflict");
    return decode(row);
  }

  async saveMayAppend(
    record: AttemptRecord & { readonly eids: readonly string[] },
  ): Promise<AttemptLookup<JsonValue>> {
    this.#driver
      .prepare(`INSERT OR IGNORE INTO host_attempts
      (key,vault,attempt_id,command_id,fingerprint,phase,eids)
      VALUES (?,?,?,?,?,'may_append',?)`)
      .run(
        record.key,
        record.vault,
        record.attemptId,
        record.commandId,
        record.fingerprint,
        JSON.stringify(record.eids),
      );
    return this.lookup(record.vault, record.key);
  }

  async markCompleted(attemptId: string, receipt: JsonValue): Promise<void> {
    const result = this.#driver
      .prepare(`UPDATE host_attempts
      SET phase='completed', receipt=?, completed_at=?
      WHERE attempt_id=? AND phase='may_append'`)
      .run(JSON.stringify(receipt), this.#now(), attemptId);
    if (result.changes !== 1) throw new Error("attempt_not_pending");
  }

  /** Only after a complete authenticated own-tail inspection proves the batch absent. */
  async markNotStarted(attemptId: string): Promise<void> {
    const result = this.#driver
      .prepare(`UPDATE host_attempts
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
  ): Promise<AttemptLookup<JsonValue>> {
    this.#driver
      .prepare(`INSERT OR IGNORE INTO host_attempts
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
  ): Promise<readonly (AttemptRecord & { readonly eids: readonly string[] })[]> {
    return this.#driver
      .prepare("SELECT * FROM host_attempts WHERE vault=? AND phase='may_append'")
      .all<Row>(vault)
      .map((row) => {
        const decoded = decode(row);
        if (decoded.phase !== "may_append") throw new Error("corrupt_attempt");
        return {
          vault: row.vault,
          key: row.key,
          attemptId: row.attempt_id,
          commandId: row.command_id,
          fingerprint: row.fingerprint,
          eids: decoded.eids,
        };
      });
  }

  /** Bounded public operation handles for UI reattachment; never exposes proof, EIDs or keys. */
  recentOperations(
    vault: string,
    commandId: string,
  ): readonly { readonly operationId: string; readonly phase: "may_append" | "completed" }[] {
    const rows = this.#driver
      .prepare(`SELECT attempt_id, phase FROM host_attempts
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
        "SELECT COUNT(*) AS count FROM host_attempts WHERE vault=? AND command_id=? AND phase='may_append'",
      )
      .get<{ count: number }>(vault, commandId);
    return (row?.count ?? 0) > 0;
  }

  /** Only the response body expires. The key, binding, phase and EIDs stay forever. */
  pruneReceipts(): number {
    return this.#driver
      .prepare("UPDATE host_attempts SET receipt=NULL WHERE phase='completed' AND completed_at < ?")
      .run(this.#now() - TTL_MS).changes;
  }
}
