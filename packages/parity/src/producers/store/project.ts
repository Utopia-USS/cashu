/**
 * View mode of the genesis roundtrip (S26 spec 8.3 `project.ts`): the rows of a folded view table ->
 * canonical source-shaped rows. Integer references go through the view's `view_ids` (view id ->
 * gid) and the vault's gid map (gid -> source row -> natural key); JSON columns map every exported
 * row's gid back to its natural key; signal keys map part by part (`GidKeys`). Values follow
 * store.py: timestamps canonical, booleans from 0 / 1, integers as `bigint`.
 */

import type { Store, TableDef } from "@cashu/store";
import type { OutValue } from "../output.ts";
import { bool, type CanonRow, compareUtf8, int, json, text, timestamp } from "./canonical.ts";
import { ROUNDTRIP_COLUMNS } from "./columns.ts";
import type { GidKeys } from "./gidKeys.ts";

/** A projected row with the gid of its view row (the join key with the inverse rows). */
export interface GidRow {
  readonly gid: string;
  readonly row: CanonRow;
}

/** View columns stored as 0 / 1 that the goldens compare as booleans. */
const BOOLEAN_COLUMNS: ReadonlySet<string> = new Set([
  "accounts.active",
  "category_rules.locked",
  "inv_profile_instruments.needs_classification",
  "connector_bindings.auto_commit",
]);

/** Compared values that are no view column (store.py `PSEUDO_COLUMNS`). */
const PSEUDO: ReadonlySet<string> = new Set(["inv_decisions.signals"]);

const isTimestamp = (column: string) => column.endsWith("_at") || column.endsWith("_until");

const viewIdCache = new WeakMap<Store, ReadonlyMap<number, string>>();

/** View-local integer id -> gid of a store (`view_ids`). */
function viewGids(store: Store): ReadonlyMap<number, string> {
  let map = viewIdCache.get(store);
  if (map === undefined) {
    map = new Map(
      store
        .read<{ id: number; gid: string }>("SELECT id, gid FROM view_ids")
        .map((r) => [r.id, r.gid]),
    );
    viewIdCache.set(store, map);
  }
  return map;
}

class ViewProjectionError extends Error {
  constructor(table: string, what: string) {
    super(`store.table.${table} view: ${what}`);
    this.name = "ViewProjectionError";
  }
}

type ViewRow = Readonly<Record<string, unknown>>;

/** The canonical value of one view column. */
function columnValue(
  table: string,
  def: TableDef,
  column: string,
  row: ViewRow,
  keys: GidKeys,
  gids: ReadonlyMap<number, string>,
): OutValue {
  const col = def.columns.find((c) => c.name === column);
  if (col === undefined) throw new ViewProjectionError(table, `no view column ${column}`);
  const value = row[column];
  if (col.ref !== undefined) {
    if (value === null || value === undefined) return null;
    const gid = gids.get(Number(value));
    if (gid === undefined) throw new ViewProjectionError(table, `${column} has no view gid`);
    return keys.ref(col.ref, gid);
  }
  if (col.json === true) {
    return value === null || value === undefined
      ? null
      : json(JSON.parse(String(value)), keys.mapString);
  }
  if (table === "inv_signals" && column === "dedup_key") return keys.dedupKey(value);
  if (table === "inv_signals" && column === "rule_id") return keys.ruleId(value);
  if (BOOLEAN_COLUMNS.has(`${table}.${column}`)) return bool(value);
  if (col.type === "INTEGER") return int(value);
  if (isTimestamp(column)) return timestamp(value);
  return text(value);
}

/** `inv_decisions.signals`: natural keys of the linked signals, sorted by UTF-8 (store.py). */
function decisionSignals(
  store: Store,
  decisionId: number,
  keys: GidKeys,
  gids: ReadonlyMap<number, string>,
): OutValue {
  const links = store.read<{ signal_id: number }>(
    "SELECT signal_id FROM inv_decision_signals WHERE decision_id = ?",
    decisionId,
  );
  const out = links.map((l) => {
    const gid = gids.get(l.signal_id);
    const key = gid === undefined ? null : keys.ref("inv_signals", gid);
    if (key === null) throw new ViewProjectionError("inv_decisions", "a link has no gid");
    return key;
  });
  return out.sort(compareUtf8);
}

/** Every row of view table `table`, projected to the golden's columns. */
export function projectView(store: Store, table: string, keys: GidKeys): GidRow[] {
  const def = store.publicTables().find((t) => t.name === table);
  if (def === undefined) throw new ViewProjectionError(table, "no such view table");
  const columns = ROUNDTRIP_COLUMNS[table];
  if (columns === undefined) throw new ViewProjectionError(table, "no roundtrip columns");
  const gids = viewGids(store);
  return store.read<ViewRow>(`SELECT * FROM ${table} ORDER BY id`).map((row) => {
    const out: Record<string, OutValue> = {};
    for (const column of columns) {
      out[column] = PSEUDO.has(`${table}.${column}`)
        ? decisionSignals(store, Number(row.id), keys, gids)
        : columnValue(table, def, column, row, keys, gids);
    }
    return { gid: String(row.gid), row: out };
  });
}
