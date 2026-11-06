/** Private local queue. Enqueue after financial append has a documented crash gap (S22c partial). */

import { toStorage } from "@cashu/domain";
import { ensureConnectorFetchState } from "../../device/connector-runs.js";
import type { SqlDriver } from "../../sql/driver.js";

export interface QueuedNotification {
  readonly id: number;
  readonly vault: string;
  readonly signal: string;
  readonly severity: string;
  readonly createdAt: string;
}
export interface NotificationState {
  readonly status: string;
  readonly severity: string;
  readonly decided: boolean;
  readonly hidden: boolean;
  readonly snoozedUntil: string | null;
}
export interface ImportedNotification {
  readonly signal: string;
  readonly severity: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly channel: string | null;
}
export interface ImportedConnectorFetch {
  readonly binding: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastOkAt: string | null;
  readonly backoffUntil: string | null;
}
/** Python runner policy uses queued severity; hidden entries close, snoozes wait before handling. */
export function notificationDisposition(
  row: QueuedNotification,
  state: NotificationState | undefined,
  now: string,
  immediate: ReadonlySet<string>,
): "send" | "wait" | "discard" {
  if (!state || state.hidden) return "discard";
  if (
    state.status === "snoozed" ||
    (state.snoozedUntil !== null && toStorage(state.snoozedUntil) > toStorage(now))
  )
    return "wait";
  return state.decided || state.status !== "active" || !immediate.has(row.severity)
    ? "discard"
    : "send";
}
export class NotificationQueue {
  private readonly driver: SqlDriver;
  constructor(driver: SqlDriver) {
    this.driver = driver;
    driver.exec(`CREATE TABLE IF NOT EXISTS local_investment_notifications (
      id INTEGER PRIMARY KEY, vault TEXT NOT NULL, signal TEXT NOT NULL,
      severity TEXT NOT NULL, created_at TEXT NOT NULL, sent_at TEXT, channel TEXT,
      UNIQUE(vault, signal, severity)
    )`);
    ensureConnectorFetchState(driver);
  }
  /** Exact one-shot history preserves sent and unsent dedup state per fresh vault. */
  restoreHistory(vault: string, rows: readonly ImportedNotification[]): void {
    this.driver.transaction(() => {
      const insert = this.driver.prepare(
        `INSERT INTO local_investment_notifications
         (vault,signal,severity,created_at,sent_at,channel) VALUES (?,?,?,?,?,?)`,
      );
      for (const row of rows)
        insert.run(vault, row.signal, row.severity, row.createdAt, row.sentAt, row.channel);
    });
  }
  history(vault: string): readonly ImportedNotification[] {
    return this.driver
      .prepare(
        `SELECT signal,severity,created_at AS createdAt,sent_at AS sentAt,channel
         FROM local_investment_notifications WHERE vault=? ORDER BY signal,severity`,
      )
      .all<ImportedNotification>(vault);
  }
  restoreConnectorFetch(vault: string, rows: readonly ImportedConnectorFetch[]): void {
    this.driver.transaction(() => {
      const insert = this.driver.prepare(
        `INSERT INTO local_connector_fetch
         (vault,binding,last_run_at,last_status,last_ok_at,backoff_until) VALUES (?,?,?,?,?,?)`,
      );
      for (const row of rows)
        insert.run(
          vault,
          row.binding,
          row.lastRunAt,
          row.lastStatus,
          row.lastOkAt,
          row.backoffUntil,
        );
    });
  }
  connectorFetch(vault: string): readonly ImportedConnectorFetch[] {
    return this.driver
      .prepare(
        `SELECT binding,last_run_at AS lastRunAt,last_status AS lastStatus,
                last_ok_at AS lastOkAt,backoff_until AS backoffUntil
         FROM local_connector_fetch WHERE vault=? ORDER BY binding`,
      )
      .all<ImportedConnectorFetch>(vault);
  }
  enqueue(vault: string, signal: string, severity: string, at: string): boolean {
    return (
      this.driver
        .prepare(`INSERT OR IGNORE INTO local_investment_notifications
      (vault,signal,severity,created_at) VALUES (?,?,?,?)`)
        .run(vault, signal, severity, toStorage(at)).changes === 1
    );
  }
  has(vault: string, signal: string, severity: string): boolean {
    return (
      this.driver
        .prepare(
          "SELECT id FROM local_investment_notifications WHERE vault=? AND signal=? AND severity=?",
        )
        .get(vault, signal, severity) !== undefined
    );
  }
  pending(vault: string, limit?: number): QueuedNotification[] {
    return this.driver
      .prepare(`SELECT id,vault,signal,severity,created_at AS createdAt
      FROM local_investment_notifications WHERE vault=? AND sent_at IS NULL ORDER BY created_at,id ${limit === undefined ? "" : "LIMIT ?"}`)
      .all<QueuedNotification>(vault, ...(limit === undefined ? [] : [limit]));
  }
  /** Claim before external delivery. A crash after claim never automatically retries. */
  claim(vault: string, id: number, at: string, channel: string): boolean {
    return (
      this.driver
        .prepare(
          "UPDATE local_investment_notifications SET sent_at=?,channel=? WHERE vault=? AND id=? AND sent_at IS NULL",
        )
        .run(toStorage(at), channel, vault, id).changes === 1
    );
  }
  /** Only an observed failed delivery releases its exact claim. */
  release(vault: string, id: number, claimedAt: string): boolean {
    return (
      this.driver
        .prepare(
          "UPDATE local_investment_notifications SET sent_at=NULL,channel=NULL WHERE vault=? AND id=? AND sent_at=?",
        )
        .run(vault, id, toStorage(claimedAt)).changes === 1
    );
  }
  /** Owner snooze drops only unsent entries, allowing a later wake to enqueue again. */
  dropUnsent(vault: string, signal: string): number {
    return this.driver
      .prepare(
        "DELETE FROM local_investment_notifications WHERE vault=? AND signal=? AND sent_at IS NULL",
      )
      .run(vault, signal).changes;
  }
}
