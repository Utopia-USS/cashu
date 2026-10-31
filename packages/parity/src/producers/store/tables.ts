/**
 * The `store.table.<table>` producers (S26 spec 8.1, 8.3): per profile, the table rebuilt from the
 * genesis roundtrip of the dataset (`genesisRun.ts`) in the golden's shape
 * `{profiles: {<profile natural key>: [rows]}}`, rows sorted as store.py sorts them. Every table comes
 * from its folded view (`project.ts`): since S24a / S25 every synced table has a materializer, so the
 * inverse mode of S26 spec 8.3 is gone.
 */

import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { type CanonRow, sortRows } from "./canonical.ts";
import { ROUNDTRIP_COLUMNS } from "./columns.ts";
import { genesisRun, type VaultRun } from "./genesisRun.ts";
import { GidKeys } from "./gidKeys.ts";
import { claimedLegs, type GidRow, projectView } from "./project.ts";

class RoundtripError extends Error {
  constructor(table: string, ordinal: number, what: string) {
    super(`store.table.${table} vault ${ordinal}: ${what}`);
    this.name = "RoundtripError";
  }
}

/** spec 8.4: the view holds one row per exported source row (minus the documented skips). */
function assertViewCount(table: string, vault: VaultRun, viewRows: number): void {
  let exported = 0;
  for (const s of vault.sources.values()) if (s.table === table) exported++;
  if (viewRows !== exported) {
    throw new RoundtripError(
      table,
      vault.ordinal,
      `view rows ${viewRows} != exported rows ${exported}`,
    );
  }
}

/** One vault's rows of a table, from its folded view. */
function viewRows(table: string, vault: VaultRun, keys: GidKeys, asOf: string): GidRow[] {
  const view = projectView(vault.store, table, keys, asOf);
  assertViewCount(table, vault, view.length - claimedLegs(vault.store, table));
  return view;
}

/** Keeps a row's columns in `ROUNDTRIP_COLUMNS` order and refuses a missing or extra column. */
function shaped(table: string, ordinal: number, row: CanonRow): CanonRow {
  const columns = ROUNDTRIP_COLUMNS[table] ?? [];
  const extra = Object.keys(row).filter((k) => !columns.includes(k));
  if (extra.length > 0 || columns.some((c) => !(c in row))) {
    throw new RoundtripError(table, ordinal, "row columns differ from ROUNDTRIP_COLUMNS");
  }
  return Object.fromEntries(columns.map((c) => [c, row[c] as OutValue]));
}

/** The `store.table.<table>` tree of a dataset. */
export function produceStoreTable(db: PythonDb, table: string): OutValue {
  const run = genesisRun(db);
  const profiles: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    const vault = run.vaults.get(p.id);
    if (vault === undefined) throw new RoundtripError(table, -1, "a profile without a vault");
    const keys = new GidKeys(vault, db.keys);
    const built = viewRows(table, vault, keys, db.asOf);
    profiles[db.keys.key("profiles", p.id)] = sortRows(
      built.map((r) => shaped(table, vault.ordinal, r.row)),
    );
  }
  return { profiles };
}

/** Every synced table with a golden (store.py `ROUNDTRIP_COLUMNS`). */
export const STORE_TABLES: readonly string[] = Object.keys(ROUNDTRIP_COLUMNS);
