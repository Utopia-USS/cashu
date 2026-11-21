// Investments transactions (events.md 6.4, 8.5; S25 spec 4.4): `invTxn.imported` is CREATE on the
// row key (resolve(account), dedupHash): the first applied member creates the row (its gid is the
// anchor) and supplies every column; later members of the key are no-ops. Import rows carry
// DET(account, dedupHashV2); manual rows a ULID with dedupHash `manual:<gid>` (unique per gid, m1).
//
// Member map (D-S2): every member gid of a row is listed in the public TS-only table
// `inv_transaction_members (gid, transaction_id)`, so a reference that names a non-anchor member (a
// planned deposit booking after an account merge) resolves to the row: readers join
// `COALESCE(members.transaction_id, fk)`.
import { ACCOUNTS } from "../core/accounts.js";
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { instrumentId, refId, str } from "./fold-values.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "inv_transactions",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "type", type: "TEXT", notNull: true },
    { name: "trade_date", type: "TEXT", notNull: true },
    { name: "settle_date", type: "TEXT" },
    { name: "instrument_id", type: "INTEGER", ref: "inv_instruments" },
    { name: "quantity", type: "TEXT" },
    { name: "price", type: "TEXT" },
    { name: "currency", type: "TEXT", notNull: true },
    { name: "gross_amount", type: "TEXT", notNull: true },
    { name: "fee", type: "TEXT", notNull: true },
    { name: "tax", type: "TEXT", notNull: true },
    { name: "cash_amount", type: "TEXT", notNull: true },
    { name: "cash_currency", type: "TEXT", notNull: true },
    { name: "fx_rate", type: "TEXT" },
    { name: "split_ratio", type: "TEXT" },
    { name: "note", type: "TEXT" },
    { name: "source", type: "TEXT", notNull: true, default: "'import'" },
    { name: "import_batch_id", type: "INTEGER", ref: "inv_import_batches" },
    { name: "external_ref", type: "TEXT" },
    { name: "dedup_hash", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [
    { columns: ["account_id", "dedup_hash"], unique: true },
    { columns: ["trade_date"] },
    { columns: ["instrument_id"] },
    { columns: ["import_batch_id"] },
  ],
};

/** Member gid -> its row (TS-only, D-S2). */
const members: TableDef = {
  name: "inv_transaction_members",
  columns: [{ name: "transaction_id", type: "INTEGER", notNull: true, ref: "inv_transactions" }],
  indexes: [{ columns: ["transaction_id"] }],
};

function key(ctx: FoldContext, account: unknown, hash: unknown): [string, string, string] {
  const root = ctx.resolve(ACCOUNTS, String(account));
  return [`${root}|${String(hash)}`, root, String(hash)];
}

export const transactionsMaterializer: Materializer = {
  id: "investments.transactions",
  version: 1,
  tables: [table, members],
  handles: ["invTxn.imported"],
  identity: [ACCOUNTS, INSTRUMENTS],
  partitions: (e, ctx) => [key(ctx, e.data.account, e.data.dedupHash)[0]],
  clear(partitions, ctx) {
    for (const p of partitions) {
      const cut = p.indexOf("|");
      const row = ctx.sql.get<{ id: number }>(
        "SELECT id FROM inv_transactions WHERE account_id = ? AND dedup_hash = ?",
        ctx.id(p.slice(0, cut)),
        p.slice(cut + 1),
      );
      if (row === undefined) continue;
      ctx.sql.write(
        members.name,
        "DELETE FROM inv_transaction_members WHERE transaction_id = ?",
        row.id,
      );
      ctx.sql.write(table.name, "DELETE FROM inv_transactions WHERE id = ?", row.id);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const [partition, root, hash] = key(ctx, d.account, d.dedupHash);
    ctx.members.add(partition, e.gid);
    const account = ctx.id(root);
    ctx.sql.write(
      table.name,
      `INSERT OR IGNORE INTO inv_transactions (id, gid, account_id, type, trade_date, settle_date,
         instrument_id, quantity, price, currency, gross_amount, fee, tax, cash_amount, cash_currency,
         fx_rate, split_ratio, note, source, import_batch_id, external_ref, dedup_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      account,
      String(d.type),
      String(d.tradeDate),
      str(d.settleDate),
      instrumentId(ctx, d.instrument),
      str(d.quantity),
      str(d.price),
      String(d.currency),
      String(d.grossAmount),
      String(d.fee),
      String(d.tax),
      String(d.cashAmount),
      String(d.cashCurrency),
      str(d.fxRate),
      str(d.splitRatio),
      str(d.note),
      String(d.source ?? "import"),
      refId(ctx, d.batch),
      str(d.externalRef),
      hash,
      ctx.time(e, "created_at", str(d.createdAt)),
    );
    ctx.sql.write(
      members.name,
      `INSERT OR IGNORE INTO inv_transaction_members (id, gid, transaction_id)
       SELECT ?, ?, id FROM inv_transactions WHERE account_id = ? AND dedup_hash = ?`,
      ctx.id(e.gid),
      e.gid,
      account,
      hash,
    );
  },
};
