// Position snapshots and instrument renames (events.md 6.4, 8.5; S25 spec 4.5).
//
// Snapshots: CREATE on (resolve(account), resolve(instrument), asOf); the first applied member wins
// a merge collision (Python keeps the target's, lead R-2 parity note); row gid = anchor.
// Renames: CREATE on (date, resolve(old), resolve(new)); the row is not shown while both ends resolve
// to one instrument (events.md 6.4), so a merge of the two hides it and nothing else changes.
import { ACCOUNTS } from "../core/accounts.js";
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { refId, str } from "./fold-values.js";
import { INSTRUMENTS } from "./instruments.js";

const snapshots: TableDef = {
  name: "inv_position_snapshots",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "as_of", type: "TEXT", notNull: true },
    { name: "quantity", type: "TEXT", notNull: true },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "avg_price", type: "TEXT" },
    { name: "market_value", type: "TEXT" },
    { name: "import_batch_id", type: "INTEGER", ref: "inv_import_batches" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id", "instrument_id", "as_of"], unique: true }],
};

const renames: TableDef = {
  name: "inv_instrument_renames",
  columns: [
    { name: "date", type: "TEXT", notNull: true },
    { name: "old_instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "new_instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "note", type: "TEXT" },
    { name: "import_batch_id", type: "INTEGER", ref: "inv_import_batches" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["date", "old_instrument_id", "new_instrument_id"], unique: true }],
};

function snapshotKey(ctx: FoldContext, d: Readonly<Record<string, unknown>>) {
  const account = ctx.resolve(ACCOUNTS, String(d.account));
  const instrument = ctx.resolve(INSTRUMENTS, String(d.instrument));
  const asOf = String(d.asOf);
  return { partition: `${account}|${instrument}|${asOf}`, account, instrument, asOf };
}

export const positionsMaterializer: Materializer = {
  id: "investments.positions",
  version: 1,
  tables: [snapshots],
  handles: ["position.snapshotImported"],
  identity: [ACCOUNTS, INSTRUMENTS],
  partitions: (e, ctx) => [snapshotKey(ctx, e.data).partition],
  clear(partitions, ctx) {
    for (const p of partitions) {
      const [account = "", instrument = "", asOf = ""] = p.split("|");
      ctx.sql.write(
        snapshots.name,
        "DELETE FROM inv_position_snapshots WHERE account_id = ? AND instrument_id = ? AND as_of = ?",
        ctx.id(account),
        ctx.id(instrument),
        asOf,
      );
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const k = snapshotKey(ctx, d);
    ctx.members.add(k.partition, e.gid);
    ctx.sql.insert(
      snapshots.name,
      `INSERT OR IGNORE INTO inv_position_snapshots (id, gid, account_id, instrument_id, as_of, quantity,
         currency, avg_price, market_value, import_batch_id, created_at)`,
      "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.id(e.gid),
      e.gid,
      ctx.id(k.account),
      ctx.id(k.instrument),
      k.asOf,
      String(d.quantity),
      String(d.currency),
      str(d.avgPrice),
      str(d.marketValue),
      refId(ctx, d.batch),
      ctx.time(e, "created_at"),
    );
  },
};

function renameKey(ctx: FoldContext, d: Readonly<Record<string, unknown>>) {
  const from = ctx.resolve(INSTRUMENTS, String(d.old));
  const to = ctx.resolve(INSTRUMENTS, String(d.new));
  const date = String(d.date);
  return { partition: `${date}|${from}|${to}`, date, from, to };
}

export const renamesMaterializer: Materializer = {
  id: "investments.renames",
  version: 1,
  tables: [renames],
  handles: ["instrumentRename.recorded"],
  identity: [INSTRUMENTS],
  partitions: (e, ctx) => [renameKey(ctx, e.data).partition],
  clear(partitions, ctx) {
    for (const p of partitions) {
      const [date = "", from = "", to = ""] = p.split("|");
      ctx.sql.write(
        renames.name,
        "DELETE FROM inv_instrument_renames WHERE date = ? AND old_instrument_id = ? AND new_instrument_id = ?",
        date,
        ctx.id(from),
        ctx.id(to),
      );
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const k = renameKey(ctx, d);
    ctx.members.add(k.partition, e.gid);
    if (k.from === k.to) return; // both ends are one instrument: no rename to show
    ctx.sql.insert(
      renames.name,
      `INSERT OR IGNORE INTO inv_instrument_renames (id, gid, date, old_instrument_id, new_instrument_id,
         note, import_batch_id, created_at)`,
      "(?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.id(e.gid),
      e.gid,
      k.date,
      ctx.id(k.from),
      ctx.id(k.to),
      str(d.note),
      refId(ctx, d.batch),
      ctx.time(e, "created_at"),
    );
  },
};
