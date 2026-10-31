// The profile row of this vault (events.md 8.2, S24 2): gid = the vault id. `profile.created` is
// CREATE (the first applied create writes every field at its position in the order; later creates
// are no-ops), `profile.renamed` is an LWW register, `profile.settingsChanged` LWW per field. The row
// is visible once a create is applied; edits folded before it are kept in `fold_profiles`.
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

const table: TableDef = {
  name: "profiles",
  columns: [
    { name: "slug", type: "TEXT", notNull: true },
    { name: "name", type: "TEXT", notNull: true },
    { name: "base_currency", type: "TEXT", notNull: true },
    { name: "mcp_privacy", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
};

const fold: TableDef = {
  name: "fold_profiles",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "created", type: "INTEGER", notNull: true },
    { name: "slug", type: "TEXT" },
    { name: "name", type: "TEXT" },
    { name: "base_currency", type: "TEXT" },
    { name: "mcp_privacy", type: "TEXT" },
    { name: "created_at", type: "TEXT" },
  ],
};

interface State {
  gid: string;
  created: number;
  slug: string | null;
  name: string | null;
  base_currency: string | null;
  mcp_privacy: string | null;
  created_at: string | null;
}

function load(ctx: FoldContext, gid: string): State {
  return (
    ctx.sql.get<State>("SELECT * FROM fold_profiles WHERE gid = ?", gid) ?? {
      gid,
      created: 0,
      slug: null,
      name: null,
      base_currency: null,
      mcp_privacy: null,
      created_at: null,
    }
  );
}

export const profilesMaterializer: Materializer = {
  id: "core.profiles",
  version: 1,
  tables: [table, fold],
  handles: ["profile.created", "profile.renamed", "profile.settingsChanged"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) {
      ctx.sql.write(table.name, "DELETE FROM profiles WHERE gid = ?", g);
      ctx.sql.write(fold.name, "DELETE FROM fold_profiles WHERE gid = ?", g);
    }
  },
  apply(e, ctx) {
    const s = load(ctx, e.gid);
    const d = e.data;
    if (e.type === "profile.created") {
      if (s.created === 1) return; // CREATE: the first applied create stands
      s.created = 1;
      s.slug = String(d.slug);
      s.name = String(d.name);
      s.base_currency = String(d.baseCurrency);
      s.mcp_privacy = String(d.mcpPrivacy);
      s.created_at = ctx.time(e, "created_at");
    } else if (e.type === "profile.renamed") {
      s.name = String(d.name);
    } else {
      if ("baseCurrency" in d) s.base_currency = String(d.baseCurrency);
      if ("mcpPrivacy" in d) s.mcp_privacy = String(d.mcpPrivacy);
    }
    ctx.sql.write(
      fold.name,
      `INSERT OR REPLACE INTO fold_profiles (gid, created, slug, name, base_currency, mcp_privacy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      s.gid,
      s.created,
      s.slug,
      s.name,
      s.base_currency,
      s.mcp_privacy,
      s.created_at,
    );
    if (s.created !== 1) return;
    ctx.sql.write(
      table.name,
      `INSERT INTO profiles (id, gid, slug, name, base_currency, mcp_privacy, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (gid) DO UPDATE SET name = excluded.name, base_currency = excluded.base_currency,
         mcp_privacy = excluded.mcp_privacy`,
      ctx.id(s.gid),
      s.gid,
      s.slug,
      s.name,
      s.base_currency,
      s.mcp_privacy,
      s.created_at,
    );
  },
};
