import { alerts } from "@cashu/domain/investments";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DetGid } from "../../gid.js";
import type { TableDef } from "../../sql/ddl.js";
import type { SqlDriver } from "../../sql/driver.js";
import { isJsonObject, KEY_PART_RE, rowIdOf } from "../idFields.js";
import {
  bool,
  type CanonRow,
  compareUtf8,
  int,
  type OutValue,
  sortRows,
  text,
  timestamp,
} from "./canonical.js";
import { ROUNDTRIP_COLUMNS } from "./columns.js";
import type { GidRow } from "./project.js";
import { sourceDerivedTransactions } from "./sourceDerived.js";
import { projectSourceJson, type SealedSourceFiles, sourceRuleKey } from "./sourceJson.js";

export interface SourceId {
  readonly table: string;
  readonly localId: string;
  readonly gid: string;
}

export class SourceProjectionError extends Error {
  constructor() {
    super("source_projection_mismatch");
    this.name = "SourceProjectionError";
  }
}

type Raw = Readonly<Record<string, unknown>>;
const ACCOUNT_SCOPED = new Set([
  "balances",
  "transactions",
  "loans",
  "depreciations",
  "asset_details",
  "inv_account_settings",
  "inv_transactions",
  "inv_position_snapshots",
]);
const BOOLEAN = new Set([
  "accounts.active",
  "category_rules.locked",
  "inv_profile_instruments.needs_classification",
  "connector_bindings.auto_commit",
  "profile_modules.enabled",
  "inv_instruments.needs_classification",
  "inv_instrument_aliases.guessed",
  "inv_topic_theses.draft",
  "transactions.is_internal_transfer",
]);
const isTimestamp = (column: string) => column.endsWith("_at") || column.endsWith("_until");

/** Enumerate source membership independently of exported IDs. */
function sourceRows(driver: SqlDriver, table: string, profileId: number): Raw[] {
  if (!/^[a-z][a-z0-9_]*$/.test(table) || !Number.isSafeInteger(profileId) || profileId <= 0) {
    throw new SourceProjectionError();
  }
  if (table === "profiles")
    return driver.prepare("SELECT * FROM profiles WHERE id=?").all<Raw>(profileId);
  if (table === "inv_instruments" || table === "inv_instrument_aliases") {
    const instrumentIds = sourceInstrumentIds(driver, profileId);
    if (table === "inv_instruments") {
      return driver
        .prepare("SELECT * FROM inv_instruments ORDER BY id")
        .all<Raw>()
        .filter((row) => instrumentIds.has(Number(row.id)));
    }
    return driver
      .prepare("SELECT * FROM inv_instrument_aliases ORDER BY id")
      .all<Raw>()
      .filter((row) => instrumentIds.has(Number(row.instrument_id)));
  }
  if (ACCOUNT_SCOPED.has(table)) {
    return driver
      .prepare(
        `SELECT t.* FROM "${table}" t JOIN accounts a ON a.id=t.account_id WHERE a.profile_id=?`,
      )
      .all<Raw>(profileId);
  }
  return driver.prepare(`SELECT * FROM "${table}" WHERE profile_id=?`).all<Raw>(profileId);
}

/** Same relational closure as genesis, but read again from the frozen SQLite source. */
export function sourceInstrumentIds(driver: SqlDriver, profileId: number): ReadonlySet<number> {
  const ids = new Set<number>();
  const add = (value: unknown) => {
    const id = rowIdOf(value);
    if (id !== undefined) ids.add(id);
  };
  const jsonField = (row: Raw, column: string, field: string): unknown => {
    const raw = row[column];
    if (raw === null || raw === undefined) return undefined;
    if (typeof raw !== "string") throw new SourceProjectionError();
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new SourceProjectionError();
    }
    // Genesis `field()` treats valid JSON scalars and arrays as having no id-bearing fields.
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>)[field];
  };
  const direct = [
    "inv_transactions",
    "inv_position_snapshots",
    "inv_manual_valuations",
    "inv_profile_instruments",
    "inv_theses",
    "alerts",
    "watchlist_items",
    "inv_decisions",
  ];
  for (const table of direct) {
    for (const row of sourceRows(driver, table, profileId)) add(row.instrument_id);
  }
  for (const row of sourceRows(driver, "inv_instrument_renames", profileId)) {
    add(row.old_instrument_id);
    add(row.new_instrument_id);
  }
  for (const row of sourceRows(driver, "inv_signals", profileId)) {
    add(row.instrument_id);
    if (typeof row.dedup_key !== "string") throw new SourceProjectionError();
    for (const part of row.dedup_key.split("|")) {
      const match = KEY_PART_RE.exec(part);
      if (match?.[1] === "i") add(Number(match[2]));
    }
    add(jsonField(row, "payload", "instrument_id"));
  }
  for (const row of sourceRows(driver, "research_notes", profileId)) {
    add(row.instrument_id);
    add(jsonField(row, "details", "previous_instrument_id"));
  }
  for (const row of sourceRows(driver, "research_runs", profileId)) {
    for (const field of ["instrument_ids", "covered_instrument_ids"]) {
      const values = jsonField(row, "scope", field);
      if (values === undefined) continue;
      // Genesis `addAll` ignores non-array scope fields; the full scope is checked separately.
      if (!Array.isArray(values)) continue;
      for (const value of values) add(value);
    }
  }
  return ids;
}

function localKey(table: string, row: Raw): string {
  if (table === "profile_modules") return `${row.profile_id}|${row.module_id}`;
  const raw = table === "inv_account_settings" ? row.account_id : row.id;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) throw new SourceProjectionError();
  return String(raw);
}

function cashLegAnchor(row: Raw): number | null {
  if (typeof row.dedup_hash !== "string") throw new SourceProjectionError();
  let raw: unknown = null;
  if (row.raw !== null && row.raw !== undefined) {
    if (typeof row.raw !== "string") throw new SourceProjectionError();
    try {
      raw = JSON.parse(row.raw);
    } catch {
      throw new SourceProjectionError();
    }
  }
  const embedded = isJsonObject(raw) ? (raw.cash_leg_of ?? null) : null;
  if (!row.dedup_hash.startsWith("cashleg:") && embedded === null) return null;
  return rowIdOf(embedded ?? row.dedup_hash.slice("cashleg:".length)) ?? -1;
}

function mappedId(ids: ReadonlyMap<string, string>, table: string, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "number" && typeof raw !== "bigint") throw new SourceProjectionError();
  const gid = ids.get(`${table}\0${raw}`);
  if (!gid) throw new SourceProjectionError();
  return gid;
}

function archive(value: unknown, row: Raw, files?: SealedSourceFiles): OutValue {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !files || value.startsWith("/") || value.includes("\\")) {
    throw new SourceProjectionError();
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new SourceProjectionError();
  }
  const name = value.split("/").at(-1);
  const match = /^([0-9a-f]{64})\.([a-zA-Z0-9]{1,10})$/.exec(name ?? "");
  if (!match) throw new SourceProjectionError();
  const bytes = files.read(value);
  if (!bytes) throw new SourceProjectionError();
  const digest = bytesToHex(sha256(bytes));
  if (digest !== match[1] || digest !== row.file_sha256) throw new SourceProjectionError();
  return { sha256: digest, ext: (match[2] as string).toLowerCase() };
}

function effectiveAlert(row: Raw, asOf: string): Raw {
  const shown = alerts.effectiveAlertStatus(
    {
      status: String(row.status) as alerts.StoredAlertStatus,
      expires_at: row.expires_at === null ? null : String(row.expires_at),
      snoozed_until: row.snoozed_until === null ? null : String(row.snoozed_until),
    },
    `${asOf}T00:00:00Z`,
  );
  return { ...row, status: shown.status, snoozed_until: shown.snoozed_until };
}

function decisionSignals(
  driver: SqlDriver,
  row: Raw,
  ids: ReadonlyMap<string, string>,
): { readonly row: Raw; readonly signals: readonly string[] } {
  const decisionId = row.id;
  if (typeof decisionId !== "number" || !Number.isSafeInteger(decisionId)) {
    throw new SourceProjectionError();
  }
  const links = driver
    .prepare("SELECT signal_id FROM inv_decision_signals WHERE decision_id=? ORDER BY signal_id")
    .all<{ signal_id: number }>(decisionId);
  const ordered = [row.signal_id, ...links.map((link) => link.signal_id)]
    .filter((value): value is number => value !== null && value !== undefined)
    .filter((value, index, all) => all.indexOf(value) === index);
  const signals = ordered.map((id) => mappedId(ids, "inv_signals", id));
  if (signals.some((gid) => gid === null)) throw new SourceProjectionError();
  return {
    row: { ...row, signal_id: ordered[0] ?? null },
    signals: (signals as string[]).sort(compareUtf8),
  };
}

function columnValue(
  table: string,
  column: string,
  row: Raw,
  def: TableDef,
  ids: ReadonlyMap<string, string>,
  files?: SealedSourceFiles,
): OutValue {
  const raw = row[column];
  const definition = def.columns.find((c) => c.name === column);
  if (!definition) throw new SourceProjectionError();
  if (definition.ref) return mappedId(ids, definition.ref, raw);
  if (table === "inv_import_batches" && column === "archive_path") return archive(raw, row, files);
  if (table === "accounts" && column === "external_id" && typeof raw === "string") {
    const localId = row.id;
    if (typeof localId === "number" && raw.endsWith(`~${localId}`)) {
      // Python parks a removed identity with its own numeric id; genesis stores the base key and
      // the removed timestamp, while the old source stays untouched for rollback.
      return raw.slice(0, -`~${localId}`.length);
    }
  }
  if (definition.json) {
    return projectSourceJson(table, column, raw, ids, files);
  }
  if (table === "inv_signals" && column === "dedup_key") {
    return sourceRuleKey(raw, ids, false);
  }
  if (table === "inv_signals" && column === "rule_id") {
    return sourceRuleKey(raw, ids, true);
  }
  if (BOOLEAN.has(`${table}.${column}`)) return bool(raw);
  if (definition.type === "INTEGER") return int(raw);
  if (isTimestamp(column)) return timestamp(raw);
  if (column === "source" && typeof raw === "string") return raw.toLowerCase();
  return text(raw);
}

/**
 * Independently project the frozen Python row fields into the same canonical columns as a replayed
 * view. Membership comes from numeric profile ownership and relational closure; the authenticated
 * per-vault map only normalizes IDs. Unsupported source transformations refuse, and callers must
 * not use partial results for admission.
 */
export function projectSourceEntries(
  driver: SqlDriver,
  table: string,
  def: TableDef,
  profileId: number,
  entries: readonly SourceId[],
  asOf: string,
  files?: SealedSourceFiles,
  det?: DetGid,
): readonly GidRow[] {
  const columns = ROUNDTRIP_COLUMNS[table];
  if (!columns) throw new SourceProjectionError();
  const ids = new Map(entries.map((entry) => [`${entry.table}\0${entry.localId}`, entry.gid]));
  const rows: GidRow[] = [];
  const selected = sourceRows(driver, table, profileId);
  const derived = table === "transactions" ? sourceDerivedTransactions(driver, profileId) : null;
  const seen = new Set<string>();
  const seenGids = new Set<string>();
  let mappedRows = 0;
  for (const raw of selected) {
    const localId = localKey(table, raw);
    const mapKey = `${table}\0${localId}`;
    if (seen.has(localId)) throw new SourceProjectionError();
    seen.add(localId);
    const cashAnchor = table === "transactions" ? cashLegAnchor(raw) : null;
    const anchorGid = cashAnchor === null ? undefined : ids.get(`transactions\0${cashAnchor}`);
    if (cashAnchor !== null && !anchorGid) throw new SourceProjectionError();
    if (cashAnchor !== null && raw.category_source !== "manual_txn") {
      if (ids.has(mapKey)) throw new SourceProjectionError();
      continue;
    }
    const gid =
      cashAnchor === null
        ? ids.get(mapKey)
        : det && anchorGid
          ? det("transactions", ["cashleg", anchorGid])
          : undefined;
    if (!gid || (cashAnchor !== null && ids.has(mapKey))) throw new SourceProjectionError();
    if (cashAnchor === null) mappedRows++;
    const decision = table === "inv_decisions" ? decisionSignals(driver, raw, ids) : null;
    const transaction = derived?.get(Number(raw.id));
    if (derived && !transaction) throw new SourceProjectionError();
    const legacyThesis =
      table === "inv_theses" && !Object.hasOwn(raw, "exit_plan_changed_at")
        ? {
            ...raw,
            exit_plan_changed_at:
              typeof raw.exit_plan === "string" && raw.exit_plan !== "" ? raw.updated_at : null,
          }
        : raw;
    const shown =
      table === "alerts"
        ? effectiveAlert(raw, asOf)
        : transaction
          ? {
              ...raw,
              category: transaction.category,
              category_source: transaction.categorySource,
              is_internal_transfer: Number(transaction.isInternalTransfer),
              transfer_group_id: mappedId(ids, "transactions", transaction.transferOutId),
            }
          : (decision?.row ?? legacyThesis);
    const result: Record<string, OutValue> = {};
    for (const column of columns) {
      result[column] =
        column === "signals" && decision
          ? [...decision.signals]
          : columnValue(table, column, shown, def, ids, files);
    }
    if (seenGids.has(gid)) throw new SourceProjectionError();
    seenGids.add(gid);
    rows.push({ gid, row: result });
  }
  if (entries.filter((entry) => entry.table === table).length !== mappedRows) {
    throw new SourceProjectionError();
  }
  return rows;
}

export function projectSourceTable(
  driver: SqlDriver,
  table: string,
  def: TableDef,
  profileId: number,
  entries: readonly SourceId[],
  asOf: string,
): readonly CanonRow[] {
  return sortRows(
    projectSourceEntries(driver, table, def, profileId, entries, asOf).map((e) => e.row),
  );
}
