/**
 * The `store.table.<table>` producers (S26 spec 8.1, 8.3): per profile, the table rebuilt from the
 * genesis roundtrip of the dataset (`genesisRun.ts`) in the golden's shape
 * `{profiles: {<profile natural key>: [rows]}}`, rows sorted as store.py sorts them. A view-mode
 * table comes from its folded view (`project.ts`), its `PENDING_ROWS` / `PENDING_COLUMNS` from the
 * inverse; an inverse-mode table from its genesis events (`inverse*.ts`).
 */

import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { type CanonRow, sortRows } from "./canonical.ts";
import { ROUNDTRIP_COLUMNS } from "./columns.ts";
import { genesisRun, type VaultRun } from "./genesisRun.ts";
import { GidKeys } from "./gidKeys.ts";
import {
  CORE_INVERSE,
  cashExpenses,
  InverseError,
  type InverseSpec,
  inverseRows,
} from "./inverse.ts";
import { INVESTMENTS_INVERSE } from "./inverseInvestments.ts";
import { JOURNAL_INVERSE } from "./inverseJournal.ts";
import { modeOf, PENDING_COLUMNS, PENDING_ROWS } from "./modes.ts";
import { type GidRow, projectView } from "./project.ts";

/** TRANSITIONAL(S24) / TRANSITIONAL(S25): the inverse builder of every table without a materializer. */
const INVERSE: Readonly<Record<string, InverseSpec>> = {
  ...CORE_INVERSE,
  ...INVESTMENTS_INVERSE,
  ...JOURNAL_INVERSE,
};

/** TRANSITIONAL(S24): inverse builders of the `PENDING_ROWS` event types. */
const PENDING_ROW_INVERSE: Readonly<Record<string, InverseSpec>> = {
  "txn.cashExpenseAdded": cashExpenses,
};

class RoundtripError extends Error {
  constructor(table: string, ordinal: number, what: string) {
    super(`store.table.${table} vault ${ordinal}: ${what}`);
    this.name = "RoundtripError";
  }
}

function inverseOf(table: string): InverseSpec {
  const spec = INVERSE[table];
  if (spec === undefined) throw new InverseError(table, "no inverse builder");
  return spec;
}

/** spec 8.4: the view holds one row per exported source row (minus the documented skips). */
function assertViewCount(table: string, vault: VaultRun, viewRows: number, pending: number): void {
  let exported = 0;
  for (const s of vault.sources.values()) if (s.table === table) exported++;
  if (viewRows + pending !== exported) {
    throw new RoundtripError(
      table,
      vault.ordinal,
      `view rows ${viewRows} + pending rows ${pending} != exported rows ${exported}`,
    );
  }
}

/** One vault's rows of a view-mode table (+ its pending rows and columns). */
function viewRows(table: string, vault: VaultRun, keys: GidKeys): GidRow[] {
  const view = projectView(vault.store, table, keys);
  const pendingRows = Object.keys(PENDING_ROWS[table] ?? {}).flatMap((type) => {
    const spec = PENDING_ROW_INVERSE[type];
    if (spec === undefined) throw new InverseError(table, `no inverse of pending ${type}`);
    return inverseRows(spec, vault.events, keys);
  });
  assertViewCount(table, vault, view.length, pendingRows.length);
  const pendingColumns = Object.keys(PENDING_COLUMNS[table] ?? {});
  if (pendingColumns.length === 0) return [...view, ...pendingRows];
  const inverse = new Map(
    inverseRows(inverseOf(table), vault.events, keys).map((r) => [r.gid, r.row]),
  );
  const merged = view.map(({ gid, row }) => {
    const source = inverse.get(gid);
    if (source === undefined) {
      throw new RoundtripError(table, vault.ordinal, "a view row without an inverse row");
    }
    const out: Record<string, OutValue> = { ...row };
    for (const c of pendingColumns) out[c] = source[c] ?? null;
    return { gid, row: out };
  });
  return [...merged, ...pendingRows];
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
    const built =
      modeOf(table) === "view"
        ? viewRows(table, vault, keys)
        : inverseRows(inverseOf(table), vault.events, keys);
    profiles[db.keys.key("profiles", p.id)] = sortRows(
      built.map((r) => shaped(table, vault.ordinal, r.row)),
    );
  }
  return { profiles };
}

/** Every synced table with a golden (store.py `ROUNDTRIP_COLUMNS`). */
export const STORE_TABLES: readonly string[] = Object.keys(ROUNDTRIP_COLUMNS);
