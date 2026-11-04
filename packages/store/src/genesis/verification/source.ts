import type { SqlDriver } from "../../sql/driver.js";
import { ROUNDTRIP_COLUMNS } from "./columns.js";
import { assertSourceCacheSchema } from "./sourceCache.js";

/** Columns with an explicit non-field reason in the Python oracle's roundtrip contract. */
const EXCLUDED: Readonly<Record<string, readonly string[]>> = {
  profiles: ["id"],
  profile_modules: ["profile_id"],
  accounts: ["id", "profile_id"],
  balances: ["id"],
  transactions: ["id", "dedup_hash"],
  category_rules: ["id", "profile_id"],
  import_batches: ["id", "profile_id"],
  loans: ["id"],
  depreciations: ["id"],
  asset_details: ["id"],
  inv_account_settings: [],
  inv_import_batches: ["id", "profile_id"],
  inv_transactions: ["id", "dedup_hash"],
  inv_position_snapshots: ["id"],
  inv_instrument_renames: ["id", "profile_id"],
  inv_manual_valuations: ["id", "profile_id"],
  inv_instruments: ["id"],
  inv_instrument_aliases: ["id"],
  inv_profile_instruments: ["id", "profile_id"],
  inv_strategy_versions: ["id", "profile_id"],
  inv_theses: ["id", "profile_id"],
  inv_topic_theses: ["id", "profile_id"],
  watchlist_items: ["id", "profile_id"],
  alerts: ["id", "profile_id"],
  inv_planned_deposits: ["id", "profile_id"],
  inv_signals: ["id", "profile_id"],
  inv_rule_runs: ["id", "profile_id"],
  inv_decisions: ["id", "profile_id"],
  reviews: ["id", "profile_id"],
  proposals: ["id", "profile_id"],
  research_runs: ["id", "profile_id"],
  research_notes: ["id", "profile_id"],
  connector_bindings: [
    "id",
    "profile_id",
    "last_run_at",
    "last_status",
    "last_ok_at",
    "backoff_until",
  ],
};

const PSEUDO: Readonly<Record<string, readonly string[]>> = { inv_decisions: ["signals"] };
const BEFORE_0027 = new Set(["0025_topic_view_sources", "0026_thesis_exit_plan_changed_at"]);
const BEFORE_0026 = new Set(["0025_topic_view_sources"]);

export class VerificationSchemaError extends Error {
  constructor() {
    super("verification_schema_mismatch");
    this.name = "VerificationSchemaError";
  }
}

/** Links are embedded in each decision's projected `signals` field, with no standalone view row. */
function assertDecisionSignalLinks(driver: SqlDriver): void {
  const columns = driver
    .prepare('PRAGMA table_info("inv_decision_signals")')
    .all<{ name: string }>()
    .map((row) => row.name);
  if (columns.length !== 2 || !columns.includes("decision_id") || !columns.includes("signal_id")) {
    throw new VerificationSchemaError();
  }
  const bad = driver
    .prepare(
      `SELECT COUNT(*) AS n FROM inv_decision_signals l
       LEFT JOIN inv_decisions d ON d.id=l.decision_id
       LEFT JOIN inv_signals s ON s.id=l.signal_id
       WHERE d.id IS NULL OR s.id IS NULL OR d.profile_id<>s.profile_id`,
    )
    .get<{ n: number }>()?.n;
  if (bad !== 0) throw new VerificationSchemaError();
}

/** Notification delivery history is compared against genesis's device-local sidecar separately. */
function assertNotificationLinks(driver: SqlDriver): void {
  const columns = driver
    .prepare('PRAGMA table_info("inv_notification_log")')
    .all<{ name: string }>()
    .map((row) => row.name);
  const expected = new Set([
    "id",
    "profile_id",
    "signal_id",
    "severity",
    "created_at",
    "sent_at",
    "channel",
  ]);
  if (columns.length !== expected.size || columns.some((column) => !expected.has(column))) {
    throw new VerificationSchemaError();
  }
  const bad = driver
    .prepare(
      `SELECT COUNT(*) AS n FROM inv_notification_log n
       LEFT JOIN inv_signals s ON s.id=n.signal_id
       WHERE s.id IS NULL OR s.profile_id<>n.profile_id`,
    )
    .get<{ n: number }>()?.n;
  if (bad !== 0) throw new VerificationSchemaError();
}

/** One-day live-app SSE invalidation history is outside durable financial state. */
function assertChangeEventSchema(driver: SqlDriver): void {
  const actual = driver
    .prepare('PRAGMA table_info("change_events")')
    .all<{ name: string; type: string; notnull: number; pk: number }>();
  const expected = [
    ["id", "INTEGER", 1, 1],
    ["ts", "DATETIME", 1, 0],
    ["profile_id", "INTEGER", 0, 0],
    ["entity", "VARCHAR", 1, 0],
    ["op", "VARCHAR", 1, 0],
    ["ref", "VARCHAR", 0, 0],
    ["payload", "JSON", 0, 0],
  ] as const;
  if (
    actual.length !== expected.length ||
    actual.some(
      (column, index) =>
        column.name !== expected[index]?.[0] ||
        column.type.toUpperCase() !== expected[index]?.[1] ||
        column.notnull !== expected[index]?.[2] ||
        column.pk !== expected[index]?.[3],
    )
  ) {
    throw new VerificationSchemaError();
  }
}

/** Historical MCP audit belongs to the device store, with profile mapped to its new vault. */
function assertMcpAuditSchema(driver: SqlDriver): void {
  const columns = driver
    .prepare('PRAGMA table_info("mcp_calls")')
    .all<{ name: string }>()
    .map((row) => row.name);
  const expected = new Set([
    "id",
    "profile_id",
    "tool",
    "privacy",
    "called_at",
    "args",
    "outcome",
    "error_kind",
    "duration_ms",
  ]);
  if (columns.length !== expected.size || columns.some((name) => !expected.has(name)))
    throw new VerificationSchemaError();
  const orphan = driver
    .prepare(
      `SELECT COUNT(*) AS n FROM mcp_calls m
     LEFT JOIN profiles p ON p.id=m.profile_id WHERE p.id IS NULL`,
    )
    .get<{ n: number }>()?.n;
  if (orphan !== 0) throw new VerificationSchemaError();
}

/** Connector code and approval metadata require native reinstall/reapproval, never authority. */
function assertConnectorCatalogSchema(driver: SqlDriver): void {
  const columns = driver
    .prepare('PRAGMA table_info("connectors")')
    .all<{ name: string }>()
    .map((row) => row.name);
  const expected = new Set([
    "id",
    "name",
    "version",
    "module",
    "kind",
    "manifest_json",
    "content_sha256",
    "interpreter_path",
    "status",
    "approved_sha256",
    "approved_interpreter",
    "approved_files_json",
    "approved_at",
    "installed_at",
    "updated_at",
    "source",
  ]);
  if (columns.length !== expected.size || columns.some((name) => !expected.has(name)))
    throw new VerificationSchemaError();
}

/** Run history survives deleted connectors and bindings; only a named profile must still exist. */
function assertConnectorRunSchema(driver: SqlDriver): void {
  const columns = driver.prepare('PRAGMA table_info("connector_runs")').all<{ name: string }>()
    .map((row) => row.name);
  const expected = new Set([
    "id", "connector_id", "profile_id", "binding_id", "command", "started_at",
    "duration_ms", "outcome", "error_kind", "exit_code", "records", "bytes_in",
    "bytes_out", "denied_hosts_json", "stderr_tail", "proposal_id", "batch_ref",
  ]);
  if (columns.length !== expected.size || columns.some((name) => !expected.has(name)))
    throw new VerificationSchemaError();
  const orphan = driver.prepare(
    `SELECT COUNT(*) AS n FROM connector_runs r
     LEFT JOIN profiles p ON p.id=r.profile_id
     WHERE r.profile_id IS NOT NULL AND p.id IS NULL`,
  ).get<{ n: number }>()?.n;
  if (orphan !== 0) throw new VerificationSchemaError();
}

/**
 * Exact source-column accounting for every synced table. Each new column must get a field mapping
 * or a reviewed exclusion before migration can proceed. Unmapped nonempty auxiliary tables refuse.
 * The old revision's two known absent columns are synthesized by genesis itself.
 */
export function assertSourceSchemaCoverage(driver: SqlDriver, revision: string): void {
  assertSourceCacheSchema(driver);
  if (
    Object.keys(ROUNDTRIP_COLUMNS).some((table) => !(table in EXCLUDED)) ||
    Object.keys(EXCLUDED).some((table) => !(table in ROUNDTRIP_COLUMNS))
  ) {
    throw new VerificationSchemaError();
  }
  for (const [table, columns] of Object.entries(ROUNDTRIP_COLUMNS)) {
    const actual = driver.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
    if (actual.length === 0) throw new VerificationSchemaError();
    const expected = new Set([...columns, ...(EXCLUDED[table] ?? [])]);
    for (const pseudo of PSEUDO[table] ?? []) expected.delete(pseudo);
    if (table === "alerts" && BEFORE_0027.has(revision)) expected.delete("tag");
    if (table === "inv_theses" && BEFORE_0026.has(revision))
      expected.delete("exit_plan_changed_at");
    const present = new Set(actual.map((column) => column.name));
    if (present.size !== expected.size || [...present].some((name) => !expected.has(name))) {
      throw new VerificationSchemaError();
    }
  }
  const names = driver
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all<{ name: string }>();
  for (const { name } of names) {
    if (name === "alembic_version" || name in ROUNDTRIP_COLUMNS) continue;
    if (name === "inv_decision_signals") {
      assertDecisionSignalLinks(driver);
      continue;
    }
    if (name === "inv_notification_log") {
      assertNotificationLinks(driver);
      continue;
    }
    if (name === "change_events") {
      assertChangeEventSchema(driver);
      continue;
    }
    if (name === "mcp_calls") {
      assertMcpAuditSchema(driver);
      continue;
    }
    if (name === "connectors") {
      assertConnectorCatalogSchema(driver);
      continue;
    }
    if (name === "connector_runs") {
      assertConnectorRunSchema(driver);
      continue;
    }
    if (name === "inv_price_bars" || name === "inv_fx_rates" || name === "inv_macro_bars") {
      // The caller captures all rows in a private typed receipt and verifies it again from source.
      continue;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new VerificationSchemaError();
    const count = driver.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get<{ n: number }>()?.n;
    if (count !== 0) throw new VerificationSchemaError();
  }
}
