// TRANSITIONAL(S49): the genesis folder reads the Python schema (Alembic 0025-0028) and goes away
// when the Python app is retired (spec D-G15).
//
// Genesis source reader (S26 spec 2.2 schema versions, 2.3 value decoding, 2.4 profile scoping,
// 3.1 tables read; impl notes "C3 provides"). Reads a COPY of the Python database through a
// `SqlDriver`: the schema version is checked, column presence comes from `PRAGMA table_info` (never
// assumed), every table is read `ORDER BY` a unique key, and each row is decoded by its table spec.
// A row that does not decode is skipped and counted `(table, reason)`; JSON number tokens that
// `JSON.parse` cannot keep are counted `json_float` / `json_big_int` (R-G9).
import type { SqlDriver, SqlRow } from "../sql/driver.js";
import { columnOf, type JsonTally, type TableSpec } from "./columns.js";
import { type GenesisCounters, GenesisError } from "./report.js";
import type { ProfileRow } from "./rows.js";
import { type PythonTables, TABLES } from "./tables.js";
import type { DecodeFailure } from "./values.js";

/** Side files of the data dir (spec 2.1), relative paths with `/`. Parsed by later phases. */
export interface GenesisFiles {
  /** The bytes of a file, undefined when it does not exist. */
  read(rel: string): Uint8Array | undefined;
  /** File names directly in a directory, sorted; empty when it does not exist. */
  list(dir: string): readonly string[];
}

/** Alembic revisions genesis reads (impl notes, change 2): 0027 / 0028 add only sync_* tables. */
const SCHEMA_VERSIONS = [
  "0025_topic_view_sources",
  "0026_thesis_exit_plan_changed_at",
  "0027_sync_outbox",
  "0028_sync_inbound",
] as const;

type SchemaVersion = (typeof SCHEMA_VERSIONS)[number];

export interface PythonSource extends PythonTables {
  readonly schema: SchemaVersion;
  readonly files: GenesisFiles;
}

function isSchemaVersion(v: unknown): v is SchemaVersion {
  return SCHEMA_VERSIONS.some((s) => s === v);
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

function readSchemaVersion(driver: SqlDriver): SchemaVersion {
  const table = driver
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alembic_version'")
    .get();
  if (table === undefined) throw new GenesisError("unsupported_schema", "no alembic_version table");
  const rows = driver.prepare("SELECT version_num FROM alembic_version").all();
  const version = rows.length === 1 ? rows[0]?.version_num : undefined;
  if (!isSchemaVersion(version)) {
    throw new GenesisError("unsupported_schema", "the alembic version is not one genesis reads");
  }
  return version;
}

// Migration 0026's backfill of `inv_theses.exit_plan_changed_at`, as the same SQL (spec 2.2), so a
// 0025 copy and the same copy migrated to 0026 decode to identical rows.
const EXIT_PLAN_BACKFILL =
  "CASE WHEN exit_plan IS NOT NULL AND exit_plan != '' THEN updated_at ELSE NULL END";

/** The SELECT expression of each spec column, from the columns the table actually has. */
function selectList(
  driver: SqlDriver,
  spec: TableSpec<unknown>,
  fields: readonly string[],
  schema: SchemaVersion,
): string {
  const present = new Set(
    driver
      .prepare(`PRAGMA table_info(${quote(spec.table)})`)
      .all<{ name: string }>()
      .map((c) => c.name),
  );
  if (present.size === 0)
    throw new GenesisError("unsupported_schema", `missing table ${spec.table}`);
  return fields
    .map((field) => {
      const column = columnOf(field);
      if (present.has(column)) return quote(column);
      if (
        spec.table === "inv_theses" &&
        column === "exit_plan_changed_at" &&
        schema === "0025_topic_view_sources"
      ) {
        return `${EXIT_PLAN_BACKFILL} AS ${quote(column)}`;
      }
      throw new GenesisError("unsupported_schema", `missing column ${spec.table}.${column}`);
    })
    .join(", ");
}

type RowResult<R> =
  | { readonly ok: true; readonly value: R; readonly tally: JsonTally }
  | { readonly ok: false; readonly reason: DecodeFailure };

function decodeRow<R>(
  spec: TableSpec<R>,
  fields: readonly (keyof R & string)[],
  raw: SqlRow,
): RowResult<R> {
  const tally: JsonTally = { floats: 0, bigInts: 0 };
  const row: Partial<Record<keyof R, unknown>> = {};
  for (const field of fields) {
    const decoded = spec.fields[field](raw[columnOf(field)] ?? null, tally);
    if (!decoded.ok) return decoded;
    row[field] = decoded.value;
  }
  // Every field of R was decoded by its own codec above: the validated boundary of this reader.
  return { ok: true, value: row as R, tally };
}

function readTable<R>(
  driver: SqlDriver,
  spec: TableSpec<R>,
  schema: SchemaVersion,
  counters: GenesisCounters,
): R[] {
  const fields: (keyof R & string)[] = [];
  for (const field in spec.fields) fields.push(field);
  const order = spec.key.map(quote).join(", ");
  const sql = `SELECT ${selectList(driver, spec, fields, schema)} FROM ${quote(spec.table)} ORDER BY ${order}`;
  const out: R[] = [];
  let floats = 0;
  let bigInts = 0;
  for (const raw of driver.prepare(sql).all<SqlRow>()) {
    const row = decodeRow(spec, fields, raw);
    if (!row.ok) {
      counters.add(spec.table, row.reason);
      continue;
    }
    floats += row.tally.floats;
    bigInts += row.tally.bigInts;
    out.push(row.value);
  }
  counters.add(spec.table, "json_float", floats);
  counters.add(spec.table, "json_big_int", bigInts);
  return out;
}

/**
 * Reads every table genesis needs from a copy of the Python database. Throws `GenesisError`
 * (`unsupported_schema`) for an Alembic version outside 0025-0028, a missing table or column.
 */
export function readPythonSource(
  driver: SqlDriver,
  files: GenesisFiles,
  counters: GenesisCounters,
): PythonSource {
  const schema = readSchemaVersion(driver);
  const read = <K extends keyof PythonTables>(k: K): PythonTables[K][number][] =>
    readTable(driver, TABLES[k], schema, counters);
  return {
    schema,
    files,
    profiles: read("profiles"),
    profileModules: read("profileModules"),
    accounts: read("accounts"),
    balances: read("balances"),
    transactions: read("transactions"),
    categoryRules: read("categoryRules"),
    importBatches: read("importBatches"),
    loans: read("loans"),
    depreciations: read("depreciations"),
    assetDetails: read("assetDetails"),
    invAccountSettings: read("invAccountSettings"),
    invImportBatches: read("invImportBatches"),
    invTransactions: read("invTransactions"),
    invPositionSnapshots: read("invPositionSnapshots"),
    invInstrumentRenames: read("invInstrumentRenames"),
    invManualValuations: read("invManualValuations"),
    invInstruments: read("invInstruments"),
    invInstrumentAliases: read("invInstrumentAliases"),
    invProfileInstruments: read("invProfileInstruments"),
    invStrategyVersions: read("invStrategyVersions"),
    invTheses: read("invTheses"),
    invTopicTheses: read("invTopicTheses"),
    watchlistItems: read("watchlistItems"),
    alerts: read("alerts"),
    invPlannedDeposits: read("invPlannedDeposits"),
    invSignals: read("invSignals"),
    invRuleRuns: read("invRuleRuns"),
    invDecisions: read("invDecisions"),
    invDecisionSignals: read("invDecisionSignals"),
    invNotificationLog: read("invNotificationLog"),
    researchRuns: read("researchRuns"),
    researchNotes: read("researchNotes"),
    reviews: read("reviews"),
    proposals: read("proposals"),
    connectorBindings: read("connectorBindings"),
  };
}

/** Python tables with no profile: instruments and aliases stay on `PythonSource` (spec 4.6). */
type GlobalTable = "profiles" | "invInstruments" | "invInstrumentAliases";
type ScopedTable = Exclude<keyof PythonTables, GlobalTable>;

/** One profile (one vault) and its rows of every profile-scoped table, in read order. */
export type ProfileScope = { readonly profile: ProfileRow } & Pick<PythonTables, ScopedTable>;

/**
 * Assigns every row to exactly one profile (spec 2.4): by `profile_id` where the table has it, by
 * `account_id -> accounts.profile_id` for the account-scoped tables, by `decision_id` for decision
 * signal links. Scoping follows the decoded rows: a row whose profile, account or decision is
 * missing (or was skipped while decoding) is skipped and counted `(table, unscoped)`. Profiles in
 * id order.
 */
export function scopeProfiles(
  source: PythonSource,
  counters: GenesisCounters,
): readonly ProfileScope[] {
  const profileIds = new Set(source.profiles.map((p) => p.id));
  const accountProfile = new Map<number, number>();
  for (const a of source.accounts) {
    if (profileIds.has(a.profileId)) accountProfile.set(a.id, a.profileId);
  }
  const decisionProfile = new Map<number, number>();
  for (const d of source.invDecisions) {
    if (profileIds.has(d.profileId)) decisionProfile.set(d.id, d.profileId);
  }
  const group = <K extends ScopedTable>(
    k: K,
    owner: (row: PythonTables[K][number]) => number | undefined,
  ): ReadonlyMap<number, PythonTables[K][number][]> => {
    const byProfile = new Map<number, PythonTables[K][number][]>();
    for (const row of source[k]) {
      const p = owner(row);
      if (p === undefined || !profileIds.has(p)) {
        counters.add(TABLES[k].table, "unscoped");
        continue;
      }
      const rows = byProfile.get(p);
      if (rows === undefined) byProfile.set(p, [row]);
      else rows.push(row);
    }
    return byProfile;
  };
  const byProfile = (r: { readonly profileId: number }) => r.profileId;
  const byAccount = (r: { readonly accountId: number }) => accountProfile.get(r.accountId);
  const g = {
    profileModules: group("profileModules", byProfile),
    accounts: group("accounts", byProfile),
    balances: group("balances", byAccount),
    transactions: group("transactions", byAccount),
    categoryRules: group("categoryRules", byProfile),
    importBatches: group("importBatches", byProfile),
    loans: group("loans", byAccount),
    depreciations: group("depreciations", byAccount),
    assetDetails: group("assetDetails", byAccount),
    invAccountSettings: group("invAccountSettings", byAccount),
    invImportBatches: group("invImportBatches", byProfile),
    invTransactions: group("invTransactions", byAccount),
    invPositionSnapshots: group("invPositionSnapshots", byAccount),
    invInstrumentRenames: group("invInstrumentRenames", byProfile),
    invManualValuations: group("invManualValuations", byProfile),
    invProfileInstruments: group("invProfileInstruments", byProfile),
    invStrategyVersions: group("invStrategyVersions", byProfile),
    invTheses: group("invTheses", byProfile),
    invTopicTheses: group("invTopicTheses", byProfile),
    watchlistItems: group("watchlistItems", byProfile),
    alerts: group("alerts", byProfile),
    invPlannedDeposits: group("invPlannedDeposits", byProfile),
    invSignals: group("invSignals", byProfile),
    invRuleRuns: group("invRuleRuns", byProfile),
    invDecisions: group("invDecisions", byProfile),
    invDecisionSignals: group("invDecisionSignals", (r) => decisionProfile.get(r.decisionId)),
    invNotificationLog: group("invNotificationLog", byProfile),
    researchRuns: group("researchRuns", byProfile),
    researchNotes: group("researchNotes", byProfile),
    reviews: group("reviews", byProfile),
    proposals: group("proposals", byProfile),
    connectorBindings: group("connectorBindings", byProfile),
  };
  return source.profiles.map((profile) => {
    const of = <T>(m: ReadonlyMap<number, T[]>): readonly T[] => m.get(profile.id) ?? [];
    return {
      profile,
      profileModules: of(g.profileModules),
      accounts: of(g.accounts),
      balances: of(g.balances),
      transactions: of(g.transactions),
      categoryRules: of(g.categoryRules),
      importBatches: of(g.importBatches),
      loans: of(g.loans),
      depreciations: of(g.depreciations),
      assetDetails: of(g.assetDetails),
      invAccountSettings: of(g.invAccountSettings),
      invImportBatches: of(g.invImportBatches),
      invTransactions: of(g.invTransactions),
      invPositionSnapshots: of(g.invPositionSnapshots),
      invInstrumentRenames: of(g.invInstrumentRenames),
      invManualValuations: of(g.invManualValuations),
      invProfileInstruments: of(g.invProfileInstruments),
      invStrategyVersions: of(g.invStrategyVersions),
      invTheses: of(g.invTheses),
      invTopicTheses: of(g.invTopicTheses),
      watchlistItems: of(g.watchlistItems),
      alerts: of(g.alerts),
      invPlannedDeposits: of(g.invPlannedDeposits),
      invSignals: of(g.invSignals),
      invRuleRuns: of(g.invRuleRuns),
      invDecisions: of(g.invDecisions),
      invDecisionSignals: of(g.invDecisionSignals),
      invNotificationLog: of(g.invNotificationLog),
      researchRuns: of(g.researchRuns),
      researchNotes: of(g.researchNotes),
      reviews: of(g.reviews),
      proposals: of(g.proposals),
      connectorBindings: of(g.connectorBindings),
    };
  });
}
