// Enabled modules (events.md 8.2, S24 2, D-24.4): one `enabled` LWW register per module (gid =
// DET[moduleId]). The row appears with the first applied enable; `enabled_at` = domain time of the
// enable that flipped the register to enabled (a redundant enable never bumps it, as Python
// `set_modules`). Registers folded before the first enable live in `fold_profile_modules`.
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

const table: TableDef = {
  name: "profile_modules",
  columns: [
    { name: "module_id", type: "TEXT", notNull: true },
    { name: "enabled", type: "INTEGER", notNull: true },
    { name: "enabled_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["module_id"], unique: true }],
};

const fold: TableDef = {
  name: "fold_profile_modules",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "module_id", type: "TEXT", notNull: true },
    { name: "enabled", type: "INTEGER", notNull: true },
    { name: "enabled_at", type: "TEXT" },
  ],
};

export const profileModulesMaterializer: Materializer = {
  id: "core.profile_modules",
  version: 1,
  tables: [table, fold],
  handles: ["module.enabled", "module.disabled"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) {
      ctx.sql.write(table.name, "DELETE FROM profile_modules WHERE gid = ?", g);
      ctx.sql.write(fold.name, "DELETE FROM fold_profile_modules WHERE gid = ?", g);
    }
  },
  apply(e, ctx) {
    const prev = ctx.sql.get<{ enabled: number; enabled_at: string | null }>(
      "SELECT enabled, enabled_at FROM fold_profile_modules WHERE gid = ?",
      e.gid,
    );
    const enable = e.type === "module.enabled";
    let enabledAt = prev?.enabled_at ?? null;
    if (enable && prev?.enabled !== 1) enabledAt = ctx.time(e, "enabled_at");
    const moduleId = String(e.data.moduleId);
    ctx.sql.write(
      fold.name,
      "INSERT OR REPLACE INTO fold_profile_modules (gid, module_id, enabled, enabled_at) VALUES (?, ?, ?, ?)",
      e.gid,
      moduleId,
      enable ? 1 : 0,
      enabledAt,
    );
    if (enabledAt === null) return; // never enabled yet: no row (Python creates it on enable)
    ctx.sql.write(
      table.name,
      `INSERT INTO profile_modules (id, gid, module_id, enabled, enabled_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET enabled = excluded.enabled, enabled_at = excluded.enabled_at
       WHERE profile_modules.enabled IS NOT excluded.enabled
         OR profile_modules.enabled_at IS NOT excluded.enabled_at`,
      ctx.id(e.gid),
      e.gid,
      moduleId,
      enable ? 1 : 0,
      enabledAt,
    );
  },
};
