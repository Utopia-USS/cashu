// The device-local store (data-flow.md "Global state, by kind": persistent app state lives in
// device-local store tables, read with useQuery). One small SQLite database per device, beside the
// vaults' view databases: which profile is current, device settings. It never syncs (events.md 10),
// so it has no event log: a device command validates its input and writes the table in one
// transaction, then the touched tables are announced like a vault apply announces its own, and the
// same `watchQuery` / `useQuery` machinery reads it.
import type { z } from "zod";
import type { CommandResult } from "../command.js";
import type { QuerySource } from "../query.js";
import type { SqlDriver, SqlValue } from "../sql/driver.js";
import { ChangeHub, type TablesListener } from "../subscribe.js";
import type { McpAuditFinish, McpAuditStart } from "./audit-types.js";

/** Device-local tables (a closed set: `tablesRead` is exact). */
export const DEVICE_TABLES = ["device_settings", "mcp_calls"] as const;

const DDL = `CREATE TABLE IF NOT EXISTS device_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vault TEXT NOT NULL,
  tool TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'strict',
  called_at TEXT NOT NULL,
  args TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'started',
  error_kind TEXT,
  duration_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS mcp_calls_vault ON mcp_calls(vault, id)`;

/** Thrown inside the transaction to roll back a refused command (never escapes `run`). */
class RefusedRollback extends Error {}

/** Keys of `device_settings` (values are validated by the commands that write them). */
export type DeviceSettingKey = "currentVault" | "languagePin" | "theme" | "updatesAuto";

export interface DeviceCommandContext {
  /** Read-only SQL on the device tables. */
  read<R>(sql: string, ...params: SqlValue[]): R[];
  /** Set (or with `null` clear) one device setting. */
  setSetting(key: DeviceSettingKey, value: string | null): void;
  startMcpCall(input: McpAuditStart): number;
  finishMcpCall(input: McpAuditFinish): boolean;
}

/** A write to device-local state: zod input, then a decision on the device tables. */
export interface DeviceCommand<I, R, In = unknown> {
  readonly id: string;
  readonly scope: "device";
  readonly input: z.ZodType<I, In>;
  run(ctx: DeviceCommandContext, input: I): CommandResult<R>;
}

export function defineDeviceCommand<I, R, In = unknown>(
  cmd: Omit<DeviceCommand<I, R, In>, "scope">,
): DeviceCommand<I, R, In> {
  return { ...cmd, scope: "device" };
}

export class DeviceStore implements QuerySource {
  readonly driver: SqlDriver;
  readonly #hub = new ChangeHub();
  readonly #tables: ReadonlySet<string> = new Set(DEVICE_TABLES);

  private constructor(driver: SqlDriver) {
    this.driver = driver;
  }

  /** Open (or create) the device store on an opened database. */
  static open(driver: SqlDriver): DeviceStore {
    driver.exec(DDL);
    return new DeviceStore(driver);
  }

  read<R>(sql: string, ...params: SqlValue[]): R[] {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("read() accepts SELECT / WITH only");
    return this.driver.prepare(sql).all<R>(...params);
  }

  tablesRead(sql: string): ReadonlySet<string> {
    const out = new Set<string>();
    for (const word of sql.toLowerCase().match(/[a-z_][a-z0-9_]*/g) ?? []) {
      if (this.#tables.has(word)) out.add(word);
    }
    return out;
  }

  subscribe(tables: Iterable<string>, listener: TablesListener): () => void {
    return this.#hub.subscribe(tables, listener);
  }

  version(tables: Iterable<string>): number {
    return this.#hub.version(tables);
  }

  /**
   * Validate `raw` with `cmd.input` and run the command in one transaction. Invalid input is refused
   * with `invalid_input`; a refusal writes nothing.
   */
  run<I, R>(cmd: DeviceCommand<I, R>, raw: unknown): CommandResult<R> {
    const parsed = cmd.input.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid_input" };
    const touched = new Set<string>();
    let result: CommandResult<R> = { ok: false, reason: "not_run" };
    try {
      this.driver.transaction(() => {
        result = cmd.run(
          {
            read: (sql, ...params) => this.read(sql, ...params),
            startMcpCall: (input) => {
              const row = this.driver
                .prepare("INSERT INTO mcp_calls (vault, tool, called_at, args) VALUES (?, ?, ?, ?)")
                .run(input.vault, input.tool, input.calledAt, JSON.stringify(input.args));
              touched.add("mcp_calls");
              return row.lastInsertRowid;
            },
            finishMcpCall: (input) => {
              const row = this.driver
                .prepare(
                  "UPDATE mcp_calls SET privacy = ?, outcome = ?, error_kind = ?, duration_ms = ? WHERE id = ? AND vault = ? AND outcome = 'started'",
                )
                .run(
                  input.privacy,
                  input.outcome,
                  input.errorKind,
                  input.durationMs,
                  input.id,
                  input.vault,
                );
              if (row.changes > 0) touched.add("mcp_calls");
              return row.changes > 0;
            },
            setSetting: (key, value) => {
              if (value === null) {
                this.driver.prepare("DELETE FROM device_settings WHERE key = ?").run(key);
              } else {
                this.driver
                  .prepare(
                    "INSERT INTO device_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                  )
                  .run(key, value);
              }
              touched.add("device_settings");
            },
          },
          parsed.data,
        );
        // A refusal writes nothing: roll the transaction back.
        if (!result.ok) throw new RefusedRollback();
      });
    } catch (error) {
      if (!(error instanceof RefusedRollback)) throw error;
      return result;
    }
    this.#hub.notify(touched);
    return result;
  }

  close(): void {
    this.driver.close();
  }
}
