// Device-only connector audit and the leader-local fetch state of each binding. Imported Python IDs are historical
// labels, never execution authority.
import type { SqlDriver } from "../sql/driver.js";

export interface ConnectorRunRecord {
  readonly id: number;
  readonly connectorId: string;
  readonly vault: string | null;
  readonly legacyProfileId: number | null;
  readonly bindingId: number | null;
  readonly command: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: string;
  readonly errorKind: string | null;
  readonly exitCode: number | null;
  readonly records: number;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly deniedHostsJson: string;
  /** Redacted before it reaches the store (Python's tail, or the host's `redactStderrTail`); never sent to MCP. */
  readonly stderrTail: string | null;
  readonly proposalId: number | null;
  readonly batchRef: string | null;
}

export type NewConnectorRun = Omit<ConnectorRunRecord, "id" | "legacyProfileId"> & {
  readonly legacyProfileId: null;
};

/** Python `KEEP_RUNS`: the newest runs kept per connector. */
export const KEEP_CONNECTOR_RUNS = 500;

const DDL = `CREATE TABLE IF NOT EXISTS connector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connector_id TEXT NOT NULL,
  vault TEXT,
  legacy_profile_id INTEGER,
  binding_id INTEGER,
  command TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  error_kind TEXT,
  exit_code INTEGER,
  records INTEGER NOT NULL,
  bytes_in INTEGER NOT NULL,
  bytes_out INTEGER NOT NULL,
  denied_hosts_json TEXT NOT NULL,
  stderr_tail TEXT,
  proposal_id INTEGER,
  batch_ref TEXT
);
CREATE INDEX IF NOT EXISTS connector_runs_vault ON connector_runs(vault, id);
CREATE INDEX IF NOT EXISTS connector_runs_connector ON connector_runs(connector_id, id)`;

export function ensureConnectorRunHistory(driver: SqlDriver): void {
  driver.exec(DDL);
}

function valid(row: ConnectorRunRecord): void {
  const nonnegative = [row.id, row.durationMs, row.records, row.bytesIn, row.bytesOut];
  if (
    nonnegative.some((n) => !Number.isSafeInteger(n) || n < 0) ||
    row.id < 1 ||
    [row.legacyProfileId, row.bindingId, row.proposalId, row.exitCode].some(
      (n) => n !== null && !Number.isSafeInteger(n),
    ) ||
    !/^[a-z][a-z0-9-]{1,39}$/.test(row.connectorId) ||
    (row.vault !== null && !/^[a-f0-9]{32}$/.test(row.vault)) ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(row.command) ||
    !/^[a-z][a-z0-9_]{0,39}$/.test(row.outcome) ||
    (row.errorKind !== null && !/^[a-z][a-z0-9_]{0,39}$/.test(row.errorKind)) ||
    row.startedAt.length < 1 ||
    row.startedAt.length > 64 ||
    row.deniedHostsJson.length > 4096 ||
    (row.stderrTail !== null && row.stderrTail.length > 4096) ||
    (row.batchRef !== null && row.batchRef.length > 256)
  )
    throw new Error("invalid connector run audit");
  let denied: unknown;
  try {
    denied = JSON.parse(row.deniedHostsJson);
  } catch {
    throw new Error("invalid connector run audit");
  }
  if (!Array.isArray(denied) || denied.some((item) => typeof item !== "string"))
    throw new Error("invalid connector run audit");
}

const COLUMNS = `connector_id, vault, legacy_profile_id, binding_id, command, started_at,
  duration_ms, outcome, error_kind, exit_code, records, bytes_in, bytes_out,
  denied_hosts_json, stderr_tail, proposal_id, batch_ref`;
const VALUES = `?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?`;

function values(row: Omit<ConnectorRunRecord, "id">) {
  return [
    row.connectorId,
    row.vault,
    row.legacyProfileId,
    row.bindingId,
    row.command,
    row.startedAt,
    row.durationMs,
    row.outcome,
    row.errorKind,
    row.exitCode,
    row.records,
    row.bytesIn,
    row.bytesOut,
    row.deniedHostsJson,
    row.stderrTail,
    row.proposalId,
    row.batchRef,
  ] as const;
}

/** Caller owns the surrounding local-state transaction. Exact legacy IDs cannot be overwritten. */
export function restoreConnectorRuns(driver: SqlDriver, rows: readonly ConnectorRunRecord[]): void {
  const insert = driver.prepare(
    `INSERT INTO connector_runs (id, ${COLUMNS}) VALUES (?, ${VALUES})`,
  );
  for (const row of rows) {
    valid(row);
    insert.run(row.id, ...values(row));
  }
}

/**
 * Runtime writes have no historical ID; the stderr tail arrives redacted. Prunes the connector's history to the newest
 * `KEEP_CONNECTOR_RUNS` rows (Python `record_run`). Caller owns the surrounding transaction.
 */
export function appendConnectorRun(driver: SqlDriver, row: NewConnectorRun): number {
  if (row.legacyProfileId !== null) throw new Error("invalid connector run audit");
  valid({ ...row, id: 1 });
  const id = driver
    .prepare(`INSERT INTO connector_runs (${COLUMNS}) VALUES (${VALUES})`)
    .run(...values(row)).lastInsertRowid;
  driver
    .prepare(
      `DELETE FROM connector_runs WHERE connector_id = ? AND id NOT IN
         (SELECT id FROM connector_runs WHERE connector_id = ? ORDER BY id DESC LIMIT ?)`,
    )
    .run(row.connectorId, row.connectorId, KEEP_CONNECTOR_RUNS);
  return id;
}

export type ConnectorRunReadScope =
  | {
      readonly kind: "vault";
      readonly vault: string;
      readonly connectorId?: string;
      readonly limit?: number;
    }
  | {
      readonly kind: "global-owner";
      readonly ownerAction: true;
      readonly isCurrent: () => boolean;
      readonly connectorId?: string;
      readonly limit?: number;
    };

const SELECT = `SELECT id, connector_id AS connectorId, vault,
  legacy_profile_id AS legacyProfileId, binding_id AS bindingId, command,
  started_at AS startedAt, duration_ms AS durationMs, outcome,
  error_kind AS errorKind, exit_code AS exitCode, records,
  bytes_in AS bytesIn, bytes_out AS bytesOut, denied_hosts_json AS deniedHostsJson,
  stderr_tail AS stderrTail, proposal_id AS proposalId, batch_ref AS batchRef
  FROM connector_runs`;

/** Vault reads cannot see another vault or global rows; global history requires owner action. */
export function listConnectorRuns(
  driver: SqlDriver,
  scope: ConnectorRunReadScope,
): ConnectorRunRecord[] {
  const limit = scope.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error("invalid connector run history limit");
  if (scope.connectorId !== undefined && !/^[a-z][a-z0-9-]{1,39}$/.test(scope.connectorId))
    throw new Error("invalid connector id");
  if (scope.kind === "vault" && !/^[a-f0-9]{32}$/.test(scope.vault))
    throw new Error("invalid vault");
  if (scope.kind === "global-owner" && (scope.ownerAction !== true || !scope.isCurrent()))
    throw new Error("connector run owner authority unavailable");
  const where = scope.kind === "vault" ? "vault = ?" : "vault IS NULL";
  const filter = scope.connectorId === undefined ? "" : " AND connector_id = ?";
  const params = [
    ...(scope.kind === "vault" ? [scope.vault] : []),
    ...(scope.connectorId === undefined ? [] : [scope.connectorId]),
    limit,
  ];
  return driver
    .prepare(`${SELECT} WHERE ${where}${filter} ORDER BY id DESC LIMIT ?`)
    .all<ConnectorRunRecord>(...params);
}

/** One binding's leader-local fetch state (Python `ConnectorBinding` last_run_at / last_status / last_ok_at /
 * backoff_until). Never syncs (events.md 10); keyed by the vault and the binding gid. */
export interface ConnectorFetchState {
  readonly binding: string;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly lastOkAt: string | null;
  readonly backoffUntil: string | null;
}
export type ConnectorFetchUpdate = Partial<Omit<ConnectorFetchState, "binding">>;

const FETCH_DDL = `CREATE TABLE IF NOT EXISTS local_connector_fetch (
  vault TEXT NOT NULL, binding TEXT NOT NULL, last_run_at TEXT, last_status TEXT,
  last_ok_at TEXT, backoff_until TEXT, PRIMARY KEY(vault,binding)
)`;

export function ensureConnectorFetchState(driver: SqlDriver): void {
  driver.exec(FETCH_DDL);
}

const FETCH_COLUMNS = {
  lastRunAt: "last_run_at",
  lastStatus: "last_status",
  lastOkAt: "last_ok_at",
  backoffUntil: "backoff_until",
} as const;

/** Set the given fields of one binding's fetch state (a missing row is created). Caller owns the transaction. */
export function updateConnectorFetch(
  driver: SqlDriver,
  vault: string,
  binding: string,
  update: ConnectorFetchUpdate,
): void {
  if (!/^[a-f0-9]{32}$/.test(vault) || binding.length < 1 || binding.length > 64)
    throw new Error("invalid connector fetch state");
  const fields = (Object.keys(FETCH_COLUMNS) as (keyof typeof FETCH_COLUMNS)[]).filter(
    (key) => update[key] !== undefined,
  );
  for (const key of fields) {
    const value = update[key];
    if (value !== null && (typeof value !== "string" || value.length < 1 || value.length > 64))
      throw new Error("invalid connector fetch state");
  }
  driver
    .prepare("INSERT OR IGNORE INTO local_connector_fetch (vault, binding) VALUES (?, ?)")
    .run(vault, binding);
  if (fields.length === 0) return;
  driver
    .prepare(
      `UPDATE local_connector_fetch SET ${fields.map((key) => `${FETCH_COLUMNS[key]} = ?`).join(", ")}
        WHERE vault = ? AND binding = ?`,
    )
    .run(...fields.map((key) => update[key] ?? null), vault, binding);
}

/** The fetch state of one binding of `vault`, or undefined. */
export function connectorFetchState(
  driver: SqlDriver,
  vault: string,
  binding: string,
): ConnectorFetchState | undefined {
  return driver
    .prepare(
      `SELECT binding, last_run_at AS lastRunAt, last_status AS lastStatus,
              last_ok_at AS lastOkAt, backoff_until AS backoffUntil
         FROM local_connector_fetch WHERE vault = ? AND binding = ?`,
    )
    .get<ConnectorFetchState>(vault, binding);
}
