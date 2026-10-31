// Watchlist (events.md 8.9, M2, N1, N3): row key resolve(instrument); `added` creates or restores
// with LWW `added_at` / `source` and note / tags only when present; `removed` is a SOFT register per
// member; the row is live while any member is live. Row gid = anchor (first applied member).
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlJson } from "../sql/values.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "watchlist_items",
  columns: [
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "note", type: "TEXT" },
    { name: "tags", type: "TEXT", notNull: true, json: true },
    { name: "source", type: "TEXT", notNull: true, default: "'user'" },
    { name: "added_at", type: "TEXT", notNull: true },
    { name: "removed_at", type: "TEXT" },
  ],
  indexes: [{ columns: ["instrument_id"], unique: true }],
};

const memberState: TableDef = {
  name: "fold_watchlist_members",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "partition", type: "TEXT", notNull: true },
    { name: "live", type: "INTEGER", notNull: true },
  ],
  indexes: [{ columns: ["partition"] }],
};

function rowGid(ctx: FoldContext, instrumentRoot: string): string | undefined {
  return ctx.sql.get<{ gid: string }>(
    "SELECT gid FROM watchlist_items WHERE instrument_id = ?",
    ctx.id(instrumentRoot),
  )?.gid;
}

export const watchlistMaterializer: Materializer = {
  id: "investments.watchlist",
  version: 1,
  tables: [table, memberState],
  handles: ["watchlist.added", "watchlist.updated", "watchlist.removed"],
  identity: [INSTRUMENTS],
  partitions(e, ctx) {
    if (e.type === "watchlist.added") return [ctx.resolve(INSTRUMENTS, String(e.data.instrument))];
    return ctx.members.partitionsOf(e.gid);
  },
  gidOf: (e, det) =>
    e.type === "watchlist.added" ? det("watchlist_items", [String(e.data.instrument)]) : undefined,
  clear(roots, ctx) {
    for (const r of roots) {
      ctx.sql.write(table.name, "DELETE FROM watchlist_items WHERE instrument_id = ?", ctx.id(r));
      ctx.sql.write(memberState.name, "DELETE FROM fold_watchlist_members WHERE partition = ?", r);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const partitions =
      e.type === "watchlist.added"
        ? [ctx.resolve(INSTRUMENTS, String(d.instrument))]
        : ctx.members.partitionsOf(e.gid); // parked until the member's `added` is held
    for (const root of partitions) {
      if (e.type === "watchlist.added") ctx.members.add(root, e.gid);
      let gid = rowGid(ctx, root);
      if (gid === undefined) {
        gid = e.gid;
        ctx.sql.write(
          table.name,
          `INSERT INTO watchlist_items (id, gid, instrument_id, note, tags, source, added_at, removed_at)
           VALUES (?, ?, ?, NULL, '[]', ?, ?, NULL)`,
          ctx.id(gid),
          gid,
          ctx.id(root),
          String(d.source ?? "user"),
          ctx.time(e, "added_at"),
        );
      }
      if (e.type === "watchlist.added") {
        ctx.sql.write(
          memberState.name,
          "INSERT OR REPLACE INTO fold_watchlist_members (gid, partition, live) VALUES (?, ?, 1)",
          e.gid,
          root,
        );
        ctx.sql.write(
          table.name,
          "UPDATE watchlist_items SET added_at = ?, source = ? WHERE gid = ?",
          ctx.time(e, "added_at"),
          String(d.source),
          gid,
        );
      } else if (e.type === "watchlist.removed") {
        ctx.sql.write(
          memberState.name,
          "UPDATE fold_watchlist_members SET live = 0 WHERE gid = ?",
          e.gid,
        );
      }
      if ("note" in d) {
        ctx.sql.write(
          table.name,
          "UPDATE watchlist_items SET note = ? WHERE gid = ?",
          (d.note as string | null) ?? null,
          gid,
        );
      }
      if ("tags" in d) {
        ctx.sql.write(
          table.name,
          "UPDATE watchlist_items SET tags = ? WHERE gid = ?",
          sqlJson(d.tags ?? []),
          gid,
        );
      }
      // N3: live while any member's own register is live; removed_at = when it stopped being live.
      const live =
        ctx.sql.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM fold_watchlist_members WHERE partition = ? AND live = 1",
          root,
        )?.n ?? 0;
      if (live > 0) {
        ctx.sql.write(
          table.name,
          "UPDATE watchlist_items SET removed_at = NULL WHERE gid = ? AND removed_at IS NOT NULL",
          gid,
        );
      } else if (e.type === "watchlist.removed") {
        ctx.sql.write(
          table.name,
          "UPDATE watchlist_items SET removed_at = ? WHERE gid = ? AND removed_at IS NULL",
          ctx.time(e, "removed_at"),
          gid,
        );
      }
    }
  },
};
