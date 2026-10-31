// The budget cushion settings (events.md 8.2, S24 2): a singleton (gid = DET["cushion"]); each
// `budgetSettings.cushionSet` carries the whole record (every field present), LWW. Python keeps it
// in `profiles/<slug>/budget.json`; the view row replaces it. `accounts` holds the resolved account
// gids (JSON list, first occurrence kept), so a query joins it on `accounts.gid`.
import { ACCOUNTS } from "../core/accounts.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlBool, sqlJson } from "../sql/values.js";

const table: TableDef = {
  name: "budget_settings",
  columns: [
    { name: "enabled", type: "INTEGER", notNull: true },
    { name: "currency", type: "TEXT" },
    { name: "target_amount", type: "TEXT" },
    { name: "target_months", type: "INTEGER" },
    { name: "accounts", type: "TEXT", notNull: true, json: true },
    { name: "monthly_max", type: "TEXT" },
  ],
};

export const budgetSettingsMaterializer: Materializer = {
  id: "budget.settings",
  version: 1,
  tables: [table],
  handles: ["budgetSettings.cushionSet"],
  identity: [ACCOUNTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(table.name, "DELETE FROM budget_settings WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    const accounts = [...new Set((d.accounts as string[]).map((g) => ctx.resolve(ACCOUNTS, g)))];
    ctx.sql.write(
      table.name,
      `INSERT INTO budget_settings (id, gid, enabled, currency, target_amount, target_months, accounts, monthly_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET enabled = excluded.enabled, currency = excluded.currency,
         target_amount = excluded.target_amount, target_months = excluded.target_months,
         accounts = excluded.accounts, monthly_max = excluded.monthly_max`,
      ctx.id(e.gid),
      e.gid,
      sqlBool(d.enabled === true),
      (d.currency as string | null) ?? null,
      (d.targetAmount as string | null) ?? null,
      (d.targetMonths as number | null) ?? null,
      sqlJson(accounts),
      (d.monthlyMax as string | null) ?? null,
    );
  },
};
