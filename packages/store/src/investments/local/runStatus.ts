/** Device-local run activity, separate from synchronized finished financial runs. */

import { addMicroseconds, parseDateTime, toStorage, utcIso } from "@cashu/domain";
import type { SqlDriver } from "../../sql/driver.js";

export interface RunActivity {
  readonly running: boolean;
  readonly startedAt: string | null;
}
export class LocalRunStatus {
  private readonly driver: SqlDriver;
  constructor(driver: SqlDriver) {
    this.driver = driver;
    driver.exec(`CREATE TABLE IF NOT EXISTS local_investment_run_activity (
      vault TEXT PRIMARY KEY, operation TEXT NOT NULL, started_at TEXT NOT NULL
    )`);
  }
  started(vault: string, at: string): void {
    this.driver
      .prepare(`INSERT INTO local_investment_run_activity VALUES (?, 'add', ?)
      ON CONFLICT(vault) DO UPDATE SET operation='add', started_at=excluded.started_at`)
      .run(vault, toStorage(at));
  }
  finished(vault: string, startedAt: string): void {
    // An older runner must not hide a newer runner's activity.
    this.driver
      .prepare(
        "UPDATE local_investment_run_activity SET operation='update' WHERE vault=? AND started_at=?",
      )
      .run(vault, toStorage(startedAt));
  }
  get(vault: string, now: string): RunActivity {
    const row = this.driver
      .prepare(
        "SELECT operation, started_at AS startedAt FROM local_investment_run_activity WHERE vault=?",
      )
      .get<{ operation: string; startedAt: string }>(vault);
    const running =
      row?.operation === "add" &&
      toStorage(now) <
        toStorage(addMicroseconds(parseDateTime(row.startedAt), 30 * 60 * 1_000_000));
    return { running, startedAt: running && row ? utcIso(row.startedAt) : null };
  }
}
