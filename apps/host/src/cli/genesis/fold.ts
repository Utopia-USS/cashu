// `--fold`: applies a vault's genesis log to a fresh file-backed store (`view.sqlite`) in
// `GENESIS_CHUNK` chunks and asserts the store-level invariants of S26 spec 8.4: nothing parked,
// rejected or suppressed, no identity conflicts, no reader behind the writer, no account conflicts,
// no unknown events (incl. `invalid-gid` parks) and one view row per exported source row.

import { writeFileSync } from "node:fs";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { builtinModules, Store, viewHash } from "@cashu/store";
import * as genesis from "@cashu/store/genesis";

/** A fold invariant failed (exit 65); the message carries counts only. */
export class FoldError extends Error {
  readonly exitCode = 65;

  constructor(message: string) {
    super(message);
    this.name = "FoldError";
  }
}

/**
 * View tables with no exported source row of their own (no `ids` entry): budget settings come from a
 * side file, members / decision links / signal aliases are embedded in their parent's events, and
 * account conflicts are derived. Every other view table is a Python table (packages/parity
 * `ROUNDTRIP_COLUMNS`).
 */
const VIEW_ONLY: ReadonlySet<string> = new Set([
  "budget_settings",
  "inv_transaction_members",
  "inv_decision_signals",
  "inv_signal_aliases",
  "account_conflicts",
]);

/** What a successful fold reports (counts and a hash only). */
export interface FoldSummary {
  /** The view hash (sha256 hex). */
  readonly view: string;
  /** View tables whose row count was compared with the export. */
  readonly tables: number;
  /** View rows compared (= exported source rows). */
  readonly rows: number;
}

const countOf = (store: Store, sql: string): number => store.read<{ n: number }>(sql)[0]?.n ?? 0;

/**
 * Spec 8.4, the rule of packages/parity `assertViewCount`: every Python view table holds exactly one
 * row per exported source row (genesis `ids` of that table). Cash mirror legs are derived (no `ids`
 * entry, events.md 9) and left out, a manual-claim leg included (parity subtracts it again).
 */
function assertViewCounts(store: Store, vault: genesis.GenesisVault): Omit<FoldSummary, "view"> {
  const exported = new Map<string, number>();
  for (const e of vault.ids) exported.set(e.table, (exported.get(e.table) ?? 0) + 1);
  const viewTables = new Set(store.publicTables().map((t) => t.name));
  const unknown = [...exported.keys()].filter((t) => !viewTables.has(t));
  if (unknown.length > 0) {
    throw new FoldError(`vault ${vault.ordinal}: ${unknown.length} exported tables have no view`);
  }
  let tables = 0;
  let rows = 0;
  const mismatched: string[] = [];
  for (const table of [...viewTables].sort()) {
    if (VIEW_ONLY.has(table)) continue;
    const view = countOf(
      store,
      table === "transactions"
        ? "SELECT COUNT(*) AS n FROM transactions WHERE COALESCE(dedup_hash, '') NOT LIKE 'cashleg:%'"
        : `SELECT COUNT(*) AS n FROM ${table}`,
    );
    const want = exported.get(table) ?? 0;
    if (view !== want) mismatched.push(`${table} view rows ${view} != exported rows ${want}`);
    tables++;
    rows += view;
  }
  if (mismatched.length > 0) {
    throw new FoldError(`vault ${vault.ordinal}: ${mismatched.join(", ")}`);
  }
  return { tables, rows };
}

/** Folds `vault` into a new store at `path`; returns the view hash and the compared counts. */
export function foldVault(
  path: string,
  vault: genesis.GenesisVault,
  keys: genesis.VaultKeys,
): FoldSummary {
  // Created empty and private first: SQLite keeps the mode of an existing file.
  writeFileSync(path, "", { mode: 0o600, flag: "wx" });
  const store = Store.open({
    driver: openNodeSqlite(path),
    vault: vault.vault,
    salt: keys.salt,
    modules: builtinModules(),
  });
  try {
    for (let i = 0; i < vault.events.length; i += genesis.GENESIS_CHUNK) {
      const r = store.applyWire({
        device: vault.device,
        events: vault.events.slice(i, i + genesis.GENESIS_CHUNK),
      });
      const broken = [
        r.parked > 0 ? `parked ${r.parked}` : "",
        r.suppressed > 0 ? `suppressed ${r.suppressed}` : "",
        r.rejected.length > 0 ? `rejected ${r.rejected.length}` : "",
        r.conflicts.length > 0 ? `conflicts ${r.conflicts.length}` : "",
        r.needsUpgrade ? "needs upgrade" : "",
      ].filter((s) => s !== "");
      if (broken.length > 0) {
        throw new FoldError(`vault ${vault.ordinal}: fold invariants failed: ${broken.join(", ")}`);
      }
    }
    if (store.needsUpgrade())
      throw new FoldError(`vault ${vault.ordinal}: the store needs an upgrade`);
    // unknown_events also holds the `invalid-gid` parks, which needsUpgrade() leaves out.
    const unknown = countOf(store, "SELECT COUNT(*) AS n FROM unknown_events");
    if (unknown > 0) throw new FoldError(`vault ${vault.ordinal}: unknown events ${unknown}`);
    const accountConflicts = countOf(store, "SELECT COUNT(*) AS n FROM account_conflicts");
    if (accountConflicts > 0) {
      throw new FoldError(`vault ${vault.ordinal}: account conflicts ${accountConflicts}`);
    }
    const counts = assertViewCounts(store, vault);
    return { view: viewHash(store).hash, ...counts };
  } finally {
    store.close();
  }
}
