// Per-profile instrument overrides (events.md 8.6): row key resolve(instrument); LWW-F over the
// fields each event sets; `plan_at` = domain time of the plan; segment GUARD: an `agent` segment is a
// no-op while the folded segment is set by the owner.
import type { FoldContext, Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import type { SqlValue } from "../sql/driver.js";
import { sqlBool, sqlJson } from "../sql/values.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "inv_profile_instruments",
  columns: [
    { name: "instrument_id", type: "INTEGER", notNull: true, ref: "inv_instruments" },
    { name: "name", type: "TEXT" },
    { name: "asset_class", type: "TEXT" },
    { name: "tags", type: "TEXT", json: true },
    { name: "region", type: "TEXT" },
    { name: "sector", type: "TEXT" },
    { name: "valuation_mode", type: "TEXT" },
    { name: "status", type: "TEXT" },
    { name: "needs_classification", type: "INTEGER" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "plan", type: "TEXT" },
    { name: "plan_at", type: "TEXT" },
    { name: "plan_reason", type: "TEXT" },
    { name: "segment", type: "TEXT" },
    { name: "segment_by", type: "TEXT" },
  ],
  indexes: [{ columns: ["instrument_id"], unique: true }],
};

/** `instrumentOverride.set` payload field -> column and encoding. */
const SET_FIELDS: readonly [string, string, (v: unknown) => SqlValue][] = [
  ["name", "name", (v) => (v as string | null) ?? null],
  ["assetClass", "asset_class", (v) => (v as string | null) ?? null],
  ["tags", "tags", (v) => (v === null || v === undefined ? null : sqlJson(v))],
  ["region", "region", (v) => (v as string | null) ?? null],
  ["sector", "sector", (v) => (v as string | null) ?? null],
  ["valuationMode", "valuation_mode", (v) => (v as string | null) ?? null],
  ["status", "status", (v) => (v as string | null) ?? null],
  [
    "needsClassification",
    "needs_classification",
    (v) => (v === null || v === undefined ? null : sqlBool(v === true)),
  ],
];

const partitionOf = (instrument: unknown, ctx: FoldContext) =>
  ctx.resolve(INSTRUMENTS, String(instrument));

export const overridesMaterializer: Materializer = {
  id: "investments.overrides",
  version: 1,
  tables: [table],
  handles: [
    "instrumentOverride.set",
    "instrumentOverride.planSet",
    "instrumentOverride.segmentSet",
  ],
  identity: [INSTRUMENTS],
  partitions: (e, ctx) => [partitionOf(e.data.instrument, ctx)],
  gidOf: (e, det) => det("inv_profile_instruments", [String(e.data.instrument)]),
  clear(roots, ctx) {
    for (const r of roots) {
      ctx.sql.write(
        table.name,
        "DELETE FROM inv_profile_instruments WHERE instrument_id = ?",
        ctx.id(r),
      );
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const root = partitionOf(d.instrument, ctx);
    ctx.members.add(root, e.gid);
    const instrumentId = ctx.id(root);
    ctx.sql.write(
      table.name,
      `INSERT OR IGNORE INTO inv_profile_instruments (id, gid, instrument_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ctx.id(e.gid),
      e.gid,
      instrumentId,
      ctx.time(e, "created_at"),
      ctx.time(e, "updated_at"),
    );
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (e.type === "instrumentOverride.set") {
      for (const [field, column, encode] of SET_FIELDS) {
        if (!(field in d)) continue;
        sets.push(`${column} = ?`);
        params.push(encode(d[field]));
      }
    } else if (e.type === "instrumentOverride.planSet") {
      const plan = (d.plan as string | null) ?? null;
      sets.push("plan = ?", "plan_reason = ?", "plan_at = ?");
      params.push(
        plan,
        (d.reason as string | null) ?? null,
        plan === null ? null : ctx.time(e, "plan_at"),
      );
    } else {
      const row = ctx.sql.get<{ segment: string | null; segment_by: string | null }>(
        "SELECT segment, segment_by FROM inv_profile_instruments WHERE instrument_id = ?",
        instrumentId,
      );
      if (d.by === "agent" && row?.segment != null && row.segment_by === "owner") return; // GUARD
      const segment = (d.segment as string | null) ?? null;
      sets.push("segment = ?", "segment_by = ?");
      params.push(segment, segment === null ? null : String(d.by));
    }
    sets.push("updated_at = ?");
    params.push(ctx.time(e, "updated_at"));
    ctx.sql.write(
      table.name,
      `UPDATE inv_profile_instruments SET ${sets.join(", ")} WHERE instrument_id = ?`,
      ...params,
      instrumentId,
    );
  },
};
