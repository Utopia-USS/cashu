// Instrument theses (events.md 8.8, 9; S25 spec 4.11): `thesis.created` CREATE, `thesis.updated`
// LWW-F, `thesis.deleted` TOMB (the row leaves the view; later events of the gid are no-ops).
//
// Derived columns (Python `store/journal.py` create_thesis / update_thesis), compared on the folded
// value so a re-delivered or reordered equal write is a no-op for them:
// - create: `core_changed_at` = domain time, `exit_plan_changed_at` = domain time when `exitPlan` is
//   non-empty, `reviewed_at` = its stamp or null (genesis stamps seed all three);
// - update: a value change of `entryType` / `thesis` / `invalidation` sets `core_changed_at`; a value
//   change of `exitPlan` sets `exit_plan_changed_at` (null when the new plan is empty); `reviewed:
//   true` sets `reviewed_at`; `updated_at` always.
// Writers clean the values (strip, empty -> null) before emitting; the fold stores what they carry.
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { hasStamp, instrumentId, nullableTime, str } from "./fold-values.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "inv_theses",
  columns: [
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "entry_type", type: "TEXT", notNull: true },
    { name: "thesis", type: "TEXT", notNull: true },
    { name: "invalidation", type: "TEXT" },
    { name: "exit_plan", type: "TEXT" },
    { name: "size_plan", type: "TEXT" },
    { name: "reviewed_at", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "core_changed_at", type: "TEXT" },
    { name: "exit_plan_changed_at", type: "TEXT" },
  ],
  indexes: [{ columns: ["instrument_id"] }],
};

/** Ended gids (TOMB): later events of the gid are no-ops, a re-create included. */
const tombs: TableDef = {
  name: "fold_thesis_tombs",
  primaryKey: ["gid"],
  internal: true,
  columns: [{ name: "gid", type: "TEXT", notNull: true }],
};

const FIELDS = {
  entryType: "entry_type",
  thesis: "thesis",
  invalidation: "invalidation",
  exitPlan: "exit_plan",
  sizePlan: "size_plan",
} as const;
const CORE = new Set(["entryType", "thesis", "invalidation"]);

type Row = Record<(typeof FIELDS)[keyof typeof FIELDS], string | null>;

export const thesesMaterializer: Materializer = {
  id: "investments.theses",
  version: 1,
  tables: [table, tombs],
  handles: ["thesis.created", "thesis.updated", "thesis.deleted"],
  identity: [INSTRUMENTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) {
      ctx.sql.write(table.name, "DELETE FROM inv_theses WHERE gid = ?", g);
      ctx.sql.write(tombs.name, "DELETE FROM fold_thesis_tombs WHERE gid = ?", g);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const g = e.gid;
    ctx.members.add(g, g);
    if (ctx.sql.get("SELECT 1 FROM fold_thesis_tombs WHERE gid = ?", g)) return;
    if (e.type === "thesis.deleted") {
      ctx.sql.write(tombs.name, "INSERT INTO fold_thesis_tombs (gid) VALUES (?)", g);
      ctx.sql.write(table.name, "DELETE FROM inv_theses WHERE gid = ?", g);
      return;
    }
    if (e.type === "thesis.created") {
      const exitPlan = str(d.exitPlan);
      ctx.sql.write(
        table.name,
        `INSERT OR IGNORE INTO inv_theses (id, gid, instrument_id, entry_type, thesis, invalidation, exit_plan,
           size_plan, reviewed_at, created_at, updated_at, core_changed_at, exit_plan_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.id(g),
        g,
        instrumentId(ctx, d.instrument),
        String(d.entryType),
        String(d.thesis),
        str(d.invalidation),
        exitPlan,
        str(d.sizePlan),
        nullableTime(e, "reviewed_at", null),
        ctx.time(e, "created_at"),
        ctx.time(e, "updated_at"),
        hasStamp(e, "core_changed_at")
          ? nullableTime(e, "core_changed_at", null)
          : ctx.time(e, "core_changed_at"),
        hasStamp(e, "exit_plan_changed_at")
          ? nullableTime(e, "exit_plan_changed_at", null)
          : exitPlan
            ? ctx.time(e, "exit_plan_changed_at")
            : null,
      );
      return;
    }
    // thesis.updated
    const row = ctx.sql.get<Row>(
      "SELECT entry_type, thesis, invalidation, exit_plan, size_plan FROM inv_theses WHERE gid = ?",
      g,
    );
    if (row === undefined) return; // parked: its create is not held
    const at = ctx.time(e, "updated_at");
    const sets = ["updated_at = ?"];
    const params: (string | null)[] = [at];
    let core = false;
    for (const [field, column] of Object.entries(FIELDS)) {
      if (!(field in d)) continue;
      const value = str(d[field]);
      if (row[column] !== value) {
        if (CORE.has(field)) core = true;
        if (field === "exitPlan") {
          sets.push("exit_plan_changed_at = ?");
          params.push(value ? ctx.time(e, "exit_plan_changed_at") : null);
        }
      }
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (core) {
      sets.push("core_changed_at = ?");
      params.push(ctx.time(e, "core_changed_at"));
    }
    if (d.reviewed === true) {
      sets.push("reviewed_at = ?");
      params.push(ctx.time(e, "reviewed_at"));
    }
    ctx.sql.write(
      table.name,
      `UPDATE inv_theses SET ${sets.join(", ")} WHERE gid = ?`,
      ...params,
      g,
    );
  },
};
