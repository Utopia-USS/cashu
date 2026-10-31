// Phase 1 of genesis, the per-row tables (S26 spec 4.1-4.10 gid column, gid.md 4.5-4.7, 7, 7.6): the
// gid map builder and the gids of the tables whose rows are keyed by columns (DET) or by their local
// id (genesis gids of ULID tables). Accounts, instruments and transactions are ids.ts's.
import type { DetGid, GidTable } from "../gid.js";
import { type GenesisCounters, GenesisError } from "./report.js";
import type { InvImportBatchRow } from "./rows.js";
import type { ProfileScope } from "./source.js";

/** The gid map of one vault while phase 1 builds it; also the vault's `GidResolver`. */
export class GidMap {
  readonly det: DetGid;
  readonly ids: { readonly table: string; readonly localId: string; readonly gid: string }[] = [];
  readonly #byTable = new Map<string, Map<string, string>>();
  /** Gids taken per table: two rows of one table never share a gid (D-G4, S26 review F5). */
  readonly #gidsByTable = new Map<string, Set<string>>();
  readonly #counters: GenesisCounters;
  readonly #ordinal: number;

  constructor(det: DetGid, counters: GenesisCounters, ordinal: number) {
    this.det = det;
    this.#counters = counters;
    this.#ordinal = ordinal;
  }

  /** `DET(genesis)[table, id]` (gid.md 7). */
  genesis(table: string, id: number): string {
    return this.det("genesis", [table, String(id)]);
  }

  /**
   * Records the gid of an exported row (and its `ids` entry). Fails closed when another row of the
   * table already holds the gid (`gid_collision`): distinct rows never merge (D-G4).
   */
  put(table: string, localId: string | number, gid: string): void {
    const key = String(localId);
    let rows = this.#byTable.get(table);
    let gids = this.#gidsByTable.get(table);
    if (rows === undefined || gids === undefined) {
      rows = new Map();
      gids = new Set();
      this.#byTable.set(table, rows);
      this.#gidsByTable.set(table, gids);
    }
    if (rows.has(key)) throw new Error(`phase 1 assigned ${table} ${key} twice`);
    if (gids.has(gid)) {
      throw new GenesisError("gid_collision", `two ${table} rows map to one gid`);
    }
    rows.set(key, gid);
    gids.add(gid);
    this.ids.push({ table, localId: key, gid });
  }

  /** A row a required reference leaves out (gid.md 7.6): no gid, counted once here. */
  leftOut(table: string): void {
    this.#counters.addVault(this.#ordinal, table, "dangling_required");
  }

  gid(table: string, localId: string): string | undefined {
    return this.#byTable.get(table)?.get(localId);
  }
}

type Lookup = (id: number) => string | undefined;

/** ULID tables of the investments owner / agent state: genesis gids, nothing required (7.6). */
const PROFILE_ROWS = [
  ["inv_strategy_versions", "invStrategyVersions"],
  ["alerts", "alerts"],
  ["inv_planned_deposits", "invPlannedDeposits"],
  ["inv_signals", "invSignals"],
  ["inv_rule_runs", "invRuleRuns"],
  ["inv_decisions", "invDecisions"],
  ["research_runs", "researchRuns"],
  ["research_notes", "researchNotes"],
  ["reviews", "reviews"],
  ["proposals", "proposals"],
  ["import_batches", "importBatches"],
] as const;

/**
 * Gids of the per-row tables of one vault (everything but profiles, modules, accounts, instruments
 * and both transaction tables). Returns the exported investment import batches by local id (the
 * investment hashes read their broker).
 */
export function stateIds(
  map: GidMap,
  scope: ProfileScope,
  acc: Lookup,
  inst: Lookup,
): ReadonlyMap<number, InvImportBatchRow> {
  const det = map.det;
  /** A DET row whose required references all resolve; else left out (7.6). */
  const keyed = (
    table: GidTable,
    localId: number,
    refs: readonly (string | undefined)[],
    parts: (refs: readonly string[]) => readonly string[],
  ) => {
    const resolved = refs.filter((r): r is string => r !== undefined);
    if (resolved.length !== refs.length) map.leftOut(table);
    else map.put(table, localId, det(table, parts(resolved)));
  };

  for (const r of scope.categoryRules)
    map.put("category_rules", r.id, det("category_rules", [r.merchantKey]));
  for (const b of scope.balances)
    keyed("balances", b.id, [acc(b.accountId)], (refs) => [...refs, b.date, b.source]);
  for (const r of scope.loans) keyed("loans", r.id, [acc(r.accountId)], (refs) => refs);
  for (const r of scope.depreciations)
    keyed("depreciations", r.id, [acc(r.accountId)], (refs) => refs);
  for (const r of scope.assetDetails)
    keyed("asset_details", r.id, [acc(r.accountId)], (refs) => refs);
  for (const r of scope.invAccountSettings) {
    keyed("inv_account_settings", r.accountId, [acc(r.accountId)], (refs) => refs);
  }
  for (const r of scope.connectorBindings) {
    keyed("connector_bindings", r.id, [acc(r.accountId)], (refs) => [...refs, r.connectorId]);
  }

  const batches = new Map<number, InvImportBatchRow>();
  for (const b of scope.invImportBatches) {
    if (acc(b.accountId) === undefined) {
      map.leftOut("inv_import_batches");
      continue;
    }
    batches.set(b.id, b);
    map.put("inv_import_batches", b.id, map.genesis("inv_import_batches", b.id));
  }

  for (const r of scope.invPositionSnapshots) {
    keyed("inv_position_snapshots", r.id, [acc(r.accountId), inst(r.instrumentId)], (refs) => [
      ...refs,
      r.asOf,
    ]);
  }
  for (const r of scope.invInstrumentRenames) {
    keyed(
      "inv_instrument_renames",
      r.id,
      [inst(r.oldInstrumentId), inst(r.newInstrumentId)],
      (refs) => [r.date, ...refs],
    );
  }
  for (const r of scope.invManualValuations) {
    keyed("inv_manual_valuations", r.id, [inst(r.instrumentId)], (refs) => [...refs, r.asOf]);
  }
  for (const r of scope.invProfileInstruments) {
    keyed("inv_profile_instruments", r.id, [inst(r.instrumentId)], (refs) => refs);
  }
  for (const r of scope.watchlistItems) {
    keyed("watchlist_items", r.id, [inst(r.instrumentId)], (refs) => refs);
  }
  for (const r of scope.invTopicTheses)
    map.put("inv_topic_theses", r.id, det("inv_topic_theses", [r.segment]));
  for (const r of scope.invTheses) {
    if (inst(r.instrumentId) === undefined) map.leftOut("inv_theses");
    else map.put("inv_theses", r.id, map.genesis("inv_theses", r.id));
  }
  for (const [table, key] of PROFILE_ROWS) {
    for (const r of scope[key]) map.put(table, r.id, map.genesis(table, r.id));
  }
  return batches;
}
