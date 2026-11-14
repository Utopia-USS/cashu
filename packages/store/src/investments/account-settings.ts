// Investments account settings (events.md 8.5; S25 spec 4.2): `invAccount.settingsSet` (gid
// DET(account)) is an LWW-F patch on the row key resolve(account). The first applied event of the
// partition creates the row (its gid is the anchor, `wrapper` defaults to 'regular' as in Python);
// `created_at` = its domain time, `updated_at` = the latest one's. Python's primary key is
// `account_id`: the view keeps `id` / `gid` and makes `account_id` unique.
import { ACCOUNTS } from "../core/accounts.js";
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { setClause, str } from "./fold-values.js";

const table: TableDef = {
  name: "inv_account_settings",
  columns: [
    { name: "account_id", type: "INTEGER", notNull: true, ref: "accounts" },
    { name: "wrapper", type: "TEXT", notNull: true, default: "'regular'" },
    { name: "importer", type: "TEXT" },
    { name: "mapping_yaml", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["account_id"], unique: true }],
};

export const accountSettingsMaterializer: Materializer = {
  id: "investments.account_settings",
  version: 1,
  tables: [table],
  handles: ["invAccount.settingsSet"],
  identity: [ACCOUNTS],
  partitions: (e, ctx) => [ctx.resolve(ACCOUNTS, String(e.data.account))],
  clear(roots, ctx) {
    for (const r of roots) {
      ctx.sql.write(table.name, "DELETE FROM inv_account_settings WHERE account_id = ?", ctx.id(r));
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const root = ctx.resolve(ACCOUNTS, String(d.account));
    ctx.members.add(root, e.gid);
    const account = ctx.id(root);
    const at = ctx.time(e, "updated_at");
    ctx.sql.write(
      table.name,
      `INSERT OR IGNORE INTO inv_account_settings (id, gid, account_id, wrapper, importer, mapping_yaml,
         created_at, updated_at) VALUES (?, ?, ?, 'regular', NULL, NULL, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      account,
      ctx.time(e, "created_at"),
      at,
    );
    const values: Record<string, string | null> = { updated_at: at };
    if ("wrapper" in d) values.wrapper = str(d.wrapper) ?? "regular";
    if ("importer" in d) values.importer = str(d.importer);
    if ("mappingYaml" in d) values.mapping_yaml = str(d.mappingYaml);
    const [set, params] = setClause(values);
    ctx.sql.write(
      table.name,
      `UPDATE inv_account_settings SET ${set} WHERE account_id = ?`,
      ...params,
      account,
    );
  },
};
