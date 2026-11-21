// Vehicle depreciation curves (events.md 8.4, S24 2): one row per resolved account (gid = the anchor,
// the first applied set), every field LWW (a `depreciation.set` carries the whole curve);
// `created_at` = the first applied set.
import { accountKeyed } from "../core/account-rows.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

const table: TableDef = {
  name: "depreciations",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "purchase_price", type: "TEXT", notNull: true },
    { name: "purchase_date", type: "TEXT", notNull: true },
    { name: "annual_rate", type: "TEXT", notNull: true },
    { name: "floor", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id"], unique: true }],
};

export const depreciationsMaterializer: Materializer = {
  id: "assets.depreciations",
  version: 1,
  tables: [table],
  handles: ["depreciation.set"],
  ...accountKeyed("depreciations"),
  clear(accounts, ctx) {
    for (const a of accounts) {
      ctx.sql.write(table.name, "DELETE FROM depreciations WHERE account_id = ?", ctx.id(a));
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const accountId = ctx.id(ctx.resolve("accounts", String(d.account)));
    const fields = [
      String(d.purchasePrice),
      String(d.purchaseDate),
      String(d.annualRate),
      (d.floor as string | null) ?? null,
    ];
    const prev = ctx.sql.get<{ id: number }>(
      "SELECT id FROM depreciations WHERE account_id = ?",
      accountId,
    );
    if (prev !== undefined) {
      ctx.sql.write(
        table.name,
        `UPDATE depreciations SET purchase_price = ?, purchase_date = ?, annual_rate = ?, floor = ?
         WHERE id = ?`,
        ...fields,
        prev.id,
      );
      return;
    }
    ctx.sql.write(
      table.name,
      `INSERT INTO depreciations (id, gid, account_id, purchase_price, purchase_date, annual_rate, floor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      accountId,
      ...fields,
      ctx.time(e, "created_at"),
    );
  },
};
