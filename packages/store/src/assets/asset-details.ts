// Notes of manual positions (events.md 8.4, S24 2, D-24.9): one row per resolved account. Python
// `set_note` creates no row for a null note, so the row appears with the first applied set carrying
// a note (gid = that event's, the anchor); once it exists every set is LWW on `note` (null keeps the
// row with `note = NULL`) and bumps `updated_at`; `created_at` = the creating set.
import { accountKeyed } from "../core/account-rows.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

const table: TableDef = {
  name: "asset_details",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "note", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id"], unique: true }],
};

export const assetDetailsMaterializer: Materializer = {
  id: "assets.asset_details",
  version: 1,
  tables: [table],
  handles: ["assetDetails.noteSet"],
  ...accountKeyed("asset_details"),
  clear(accounts, ctx) {
    for (const a of accounts) {
      ctx.sql.write(table.name, "DELETE FROM asset_details WHERE account_id = ?", ctx.id(a));
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const accountId = ctx.id(ctx.resolve("accounts", String(d.account)));
    const note = (d.note as string | null) ?? null;
    const at = ctx.time(e, "updated_at");
    const prev = ctx.sql.get<{ id: number }>(
      "SELECT id FROM asset_details WHERE account_id = ?",
      accountId,
    );
    if (prev !== undefined) {
      ctx.sql.write(
        table.name,
        "UPDATE asset_details SET note = ?, updated_at = ? WHERE id = ?",
        note,
        at,
        prev.id,
      );
      return;
    }
    if (note === null) return; // no row for a null note (D-24.9)
    ctx.sql.write(
      table.name,
      `INSERT INTO asset_details (id, gid, account_id, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      accountId,
      note,
      ctx.time(e, "created_at"),
      at,
    );
  },
};
