// Merchant category rules (events.md 8.3): one row per merchant key (DET gid), LWW over the fields,
// GUARD: an `llm` rule is a no-op while the folded rule is locked (manual corrections win).
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlBool } from "../sql/values.js";

const table: TableDef = {
  name: "category_rules",
  columns: [
    { name: "merchant_key", type: "TEXT", notNull: true },
    { name: "category", type: "TEXT", notNull: true },
    { name: "source", type: "TEXT", notNull: true, default: "'manual'" },
    { name: "locked", type: "INTEGER", notNull: true, default: "0" },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["merchant_key"], unique: true }],
};

export const categoryRulesMaterializer: Materializer = {
  id: "budget.category_rules",
  version: 1,
  tables: [table],
  handles: ["categoryRule.set"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(table.name, "DELETE FROM category_rules WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    const prev = ctx.sql.get<{ locked: number }>(
      "SELECT locked FROM category_rules WHERE gid = ?",
      e.gid,
    );
    if (prev && prev.locked === 1 && d.source === "llm") return; // GUARD
    ctx.sql.write(
      table.name,
      `INSERT INTO category_rules (id, gid, merchant_key, category, source, locked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET merchant_key = excluded.merchant_key, category = excluded.category,
         source = excluded.source, locked = excluded.locked`,
      ctx.id(e.gid),
      e.gid,
      String(d.merchantKey),
      String(d.category),
      String(d.source),
      sqlBool(d.locked === true),
      ctx.time(e, "created_at"),
    );
  },
};
