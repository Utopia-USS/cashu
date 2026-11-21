// Reviews (events.md 8.10; S25 spec 4.16): `review.done` APPEND (`done_at` = domain time, the
// payload's `doneAt` when given), `review.undone` TOMB. `reviews` is a core table with a `module`
// column; it is folded here because the investments review deck is its only writer today and the core
// module belongs to S24 (spec R-S10: the registry rejects a table owned twice, so a second fold fails
// loudly). Moving the file into `core/` later changes no table or event.
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { json, str } from "./fold-values.js";

const table: TableDef = {
  name: "reviews",
  columns: [
    { name: "module", type: "TEXT", notNull: true },
    { name: "done_at", type: "TEXT", notNull: true },
    { name: "notes", type: "TEXT" },
    { name: "stats", type: "TEXT", notNull: true, json: true },
  ],
  indexes: [{ columns: ["module", "done_at"] }],
};

const tombs: TableDef = {
  name: "fold_review_tombs",
  primaryKey: ["gid"],
  internal: true,
  columns: [{ name: "gid", type: "TEXT", notNull: true }],
};

export const reviewsMaterializer: Materializer = {
  id: "investments.reviews",
  version: 1,
  tables: [table, tombs],
  handles: ["review.done", "review.undone"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) {
      ctx.sql.write(table.name, "DELETE FROM reviews WHERE gid = ?", g);
      ctx.sql.write(tombs.name, "DELETE FROM fold_review_tombs WHERE gid = ?", g);
    }
  },
  apply(e, ctx) {
    const g = e.gid;
    ctx.members.add(g, g);
    if (ctx.sql.get("SELECT 1 FROM fold_review_tombs WHERE gid = ?", g)) return;
    if (e.type === "review.undone") {
      ctx.sql.write(tombs.name, "INSERT INTO fold_review_tombs (gid) VALUES (?)", g);
      ctx.sql.write(table.name, "DELETE FROM reviews WHERE gid = ?", g);
      return;
    }
    const d = e.data;
    ctx.sql.write(
      table.name,
      "INSERT OR IGNORE INTO reviews (id, gid, module, done_at, notes, stats) VALUES (?, ?, ?, ?, ?, ?)",
      ctx.id(g),
      g,
      String(d.module),
      ctx.time(e, "done_at", str(d.doneAt)),
      str(d.notes),
      json(d.stats ?? {}),
    );
  },
};
