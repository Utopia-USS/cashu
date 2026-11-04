import { type FoldContext, type Materializer, ord } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";

const runs: TableDef = {
  name: "transfer_runs",
  primaryKey: ["gid"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "run_ord", type: "TEXT", notNull: true },
    { name: "reset", type: "INTEGER", notNull: true },
    { name: "max_days", type: "INTEGER", notNull: true },
    { name: "pair_count", type: "INTEGER", notNull: true },
  ],
};

const pairs: TableDef = {
  name: "transfer_run_pairs",
  primaryKey: ["run", "ordinal"],
  internal: true,
  withoutRowid: true,
  columns: [
    { name: "run", type: "TEXT", notNull: true },
    { name: "ordinal", type: "INTEGER", notNull: true },
    { name: "out_gid", type: "TEXT", notNull: true },
    { name: "in_gid", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["run"] }],
};

/** One partition per run, so late delivery and a re-fold never mix claims from different runs. */
export const transferRunsMaterializer: Materializer = {
  id: "budget.transfer_runs",
  version: 1,
  tables: [runs, pairs],
  handles: ["transferRun.started", "transferPair.claimed"],
  partitions: (e) => [e.type === "transferPair.claimed" ? String(e.data.run) : e.gid],
  clear(partitions, ctx) {
    for (const gid of partitions) {
      ctx.sql.write(runs.name, "DELETE FROM transfer_runs WHERE gid = ?", gid);
      ctx.sql.write(pairs.name, "DELETE FROM transfer_run_pairs WHERE run = ?", gid);
    }
  },
  apply(e, ctx: FoldContext) {
    if (e.type === "transferRun.started") {
      ctx.sql.write(
        runs.name,
        "INSERT OR IGNORE INTO transfer_runs (gid, run_ord, reset, max_days, pair_count) VALUES (?, ?, ?, ?, ?)",
        e.gid,
        ord(e),
        e.data.reset ? 1 : 0,
        Number(e.data.maxDays),
        Number(e.data.pairCount),
      );
      return;
    }
    if (String(e.data.run) !== e.gid) return;
    ctx.sql.write(
      pairs.name,
      "INSERT OR IGNORE INTO transfer_run_pairs (run, ordinal, out_gid, in_gid) VALUES (?, ?, ?, ?)",
      e.gid,
      Number(e.data.ordinal),
      String(e.data.out),
      String(e.data.in),
    );
  },
};
