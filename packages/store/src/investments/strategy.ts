// Strategy versions and rule runs (events.md 8.7, 8.8; S25 spec 4.6, 4.7).
//
// Strategy: `strategy.versionSaved` is APPEND over one partition (`strategy`, the whole table:
// numbers are a function of the order, D-S8). A version whose sha256 equals the current (highest)
// version's is a no-op (m9: two desktops ingesting one external edit); otherwise it becomes
// `version = max + 1`. A revert to an older sha is a new version. "Current" = max version (a query).
// A rule run naming a no-op version's gid points at no row (R-S6).
//
// Rule runs: `ruleRun.finished` is APPEND (LEADER, every run kept, O6); `report.new` / `escalated`
// stay signal gids in JSON.
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { json, nullableTime, refId, str } from "./fold-values.js";

const versions: TableDef = {
  name: "inv_strategy_versions",
  columns: [
    { name: "version", type: "INTEGER", notNull: true },
    { name: "sha256", type: "TEXT", notNull: true },
    { name: "yaml_text", type: "TEXT", notNull: true },
    { name: "md_text", type: "TEXT" },
    { name: "state", type: "TEXT", notNull: true },
    { name: "issues", type: "TEXT", notNull: true, json: true },
    { name: "created_at", type: "TEXT", notNull: true },
  ],
  indexes: [{ columns: ["version"], unique: true }],
};

const STRATEGY = "strategy";

export const strategyMaterializer: Materializer = {
  id: "investments.strategy",
  version: 1,
  tables: [versions],
  handles: ["strategy.versionSaved"],
  partitions: () => [STRATEGY],
  clear(_partitions, ctx) {
    ctx.sql.write(versions.name, "DELETE FROM inv_strategy_versions");
  },
  apply(e, ctx) {
    const d = e.data;
    ctx.members.add(STRATEGY, e.gid);
    if (ctx.sql.get("SELECT 1 FROM inv_strategy_versions WHERE gid = ?", e.gid)) return; // CREATE
    const current = ctx.sql.get<{ version: number; sha256: string }>(
      "SELECT version, sha256 FROM inv_strategy_versions ORDER BY version DESC LIMIT 1",
    );
    if (current?.sha256 === d.sha256) return; // m9: same content as the current version
    ctx.sql.write(
      versions.name,
      `INSERT INTO inv_strategy_versions (id, gid, version, sha256, yaml_text, md_text, state, issues, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      (current?.version ?? 0) + 1,
      String(d.sha256),
      String(d.yamlText),
      str(d.mdText),
      String(d.state),
      json(d.issues ?? []),
      ctx.time(e, "created_at"),
    );
  },
};

const runs: TableDef = {
  name: "inv_rule_runs",
  columns: [
    { name: "trigger", type: "TEXT", notNull: true },
    { name: "as_of", type: "TEXT", notNull: true },
    { name: "status", type: "TEXT", notNull: true },
    { name: "strategy_version_id", type: "INTEGER", ref: "inv_strategy_versions" },
    { name: "stats", type: "TEXT", notNull: true, json: true },
    { name: "errors", type: "TEXT", notNull: true, json: true },
    { name: "report", type: "TEXT", notNull: true, json: true },
    { name: "started_at", type: "TEXT", notNull: true },
    { name: "finished_at", type: "TEXT" },
  ],
};

export const ruleRunsMaterializer: Materializer = {
  id: "investments.rule_runs",
  version: 1,
  tables: [runs],
  handles: ["ruleRun.finished"],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(runs.name, "DELETE FROM inv_rule_runs WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    ctx.members.add(e.gid, e.gid);
    ctx.sql.insert(
      runs.name,
      `INSERT OR IGNORE INTO inv_rule_runs (id, gid, trigger, as_of, status, strategy_version_id, stats,
         errors, report, started_at, finished_at)`,
      "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ctx.id(e.gid),
      e.gid,
      String(d.trigger),
      String(d.asOf),
      String(d.status),
      refId(ctx, d.strategyVersion),
      json(d.stats ?? {}),
      json(d.errors ?? []),
      json(d.report ?? { new: [], escalated: [] }),
      ctx.time(e, "started_at", str(d.startedAt)),
      nullableTime(e, "finished_at", d.finishedAt),
    );
  },
};
