// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Outbox values -> the genesis row shapes (S31a spec 4.4): `post` (and `pre` = `post` overlaid with
// `prev`, or a delete's last state) is decoded by the genesis table spec of the Python table, so the
// bridge runs the genesis mappers on exactly the typed rows genesis reads from SQLite. The outbox
// stores values as SQLite stores them except JSON columns, which it keeps parsed: those go back to
// JSON text before decoding.
import { jsonList, jsonN, jsonObject, type TableSpec } from "../genesis/columns.js";
import { decodeSourceRow } from "../genesis/source.js";
import { TABLES } from "../genesis/tables.js";
import type { SqlRow } from "../sql/driver.js";

const SPECS: ReadonlyMap<string, TableSpec<unknown>> = new Map(
  Object.values(TABLES).map((s: TableSpec<unknown>) => [s.table, s]),
);
const JSON_CODECS: ReadonlySet<unknown> = new Set([jsonObject, jsonList, jsonN]);

/** The genesis table spec of a Python table, undefined for a table genesis does not read. */
function specOf(table: string): TableSpec<unknown> | undefined {
  return SPECS.get(table);
}

/** Outbox values (JSON columns parsed) -> the raw SQL row the genesis decoders read. */
function rawOf(spec: TableSpec<unknown>, values: Readonly<Record<string, unknown>>): SqlRow {
  const raw: Record<string, unknown> = {};
  const codecs = spec.fields as Readonly<Record<string, unknown>>;
  for (const [field, codec] of Object.entries(codecs)) {
    const column = field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    if (!(column in values)) continue;
    const v = values[column];
    raw[column] = JSON_CODECS.has(codec) && v !== null && v !== undefined ? JSON.stringify(v) : v;
  }
  return raw as SqlRow;
}

export type DecodeOutcome<R> =
  | { readonly ok: true; readonly row: R }
  | { readonly ok: false; readonly reason: string };

/**
 * Decodes outbox values of `table` into the genesis row shape. Integer primary keys come from the
 * local id when the values lack them (Python's `post` omits nothing, a delete's `fields` omit
 * derived columns, which the decoder then reports missing).
 */
export function decodeValues<R>(
  table: string,
  values: Readonly<Record<string, unknown>>,
): DecodeOutcome<R> {
  const spec = specOf(table);
  if (spec === undefined) return { ok: false, reason: `no-spec:${table}` };
  const r = decodeSourceRow(spec, rawOf(spec, values));
  return r.ok ? { ok: true, row: r.value as R } : { ok: false, reason: `decode:${table}` };
}
