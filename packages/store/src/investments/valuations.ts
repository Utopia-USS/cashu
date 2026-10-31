// Manual valuations (events.md 8.5): row key (resolve(instrument), asOf); LWW-F over value, currency
// and note; row gid = anchor (first applied member).
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "inv_manual_valuations",
  columns: [
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "as_of", type: "TEXT", notNull: true },
    { name: "unit_value", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "note", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["instrument_id", "as_of"], unique: true }],
};

function key(ctx: FoldContext, instrument: unknown, asOf: unknown): [string, string, string] {
  const root = ctx.resolve(INSTRUMENTS, String(instrument));
  return [`${root}|${String(asOf)}`, root, String(asOf)];
}

export const valuationsMaterializer: Materializer = {
  id: "investments.valuations",
  version: 1,
  tables: [table],
  handles: ["valuation.set"],
  identity: [INSTRUMENTS],
  partitions: (e, ctx) => [key(ctx, e.data.instrument, e.data.asOf)[0]],
  gidOf: (e, det) => det("inv_manual_valuations", [String(e.data.instrument), String(e.data.asOf)]),
  clear(partitions, ctx) {
    for (const p of partitions) {
      const [root = "", asOf = ""] = p.split("|");
      ctx.sql.write(
        table.name,
        "DELETE FROM inv_manual_valuations WHERE instrument_id = ? AND as_of = ?",
        ctx.id(root),
        asOf,
      );
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const [partition, root, asOf] = key(ctx, d.instrument, d.asOf);
    ctx.members.add(partition, e.gid);
    ctx.sql.write(
      table.name,
      `INSERT INTO inv_manual_valuations (id, gid, instrument_id, as_of, unit_value, currency, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (instrument_id, as_of) DO UPDATE SET unit_value = excluded.unit_value,
         currency = excluded.currency, note = excluded.note`,
      ctx.id(e.gid),
      e.gid,
      ctx.id(root),
      asOf,
      String(d.unitValue),
      String(d.currency),
      (d.note as string | null) ?? null,
      ctx.time(e, "created_at"),
    );
  },
};
