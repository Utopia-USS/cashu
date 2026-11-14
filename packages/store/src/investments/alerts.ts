// Alerts (events.md 8.7; S25 spec 4.10, D-S1). Owner config and owner state (`alert.created`,
// `updated`, `statusSet`, `deleted`, `restored`) and the evaluator's runtime state (`alert.evaluated`,
// LEADER) are separate registers; the stored `status` is the clock-free fold status
// `muted > snoozed > triggered > active` (owner register first, then the runtime register). Expiry
// and the end of a snooze depend on the reader's clock: readers call `effectiveAlertStatus(row, now)`
// (`@cashu/domain`), never the raw column.
//
// | event      | effect |
// | created    | CREATE: config (tag absent = null), owner active, not triggered, created_at = updated_at = domain time |
// | updated    | LWW-F on present config fields (tag included, S31c); updated_at |
// | statusSet  | owner := status, snoozed_until := snoozedUntil; muted / snoozed clear triggered (Python
// |            | overwrites the status), active keeps it; updated_at |
// | deleted    | deleted_at (SOFT, no updated_at bump, as Python) |
// | restored   | deleted_at := null; `rearm` clears triggered (S25-F6); updated_at |
// | evaluated  | triggered := data.triggered, last_* LWW when present; an evaluation whose lastCheckedAt is
// |            | at or after the snooze end ends the snooze (owner active); no updated_at bump |
import type { FoldContext, Materializer } from "../engine/types.js";
import { restoreFloats } from "../events/v1/primitives.js";
import type { TableDef } from "../sql/ddl.js";
import { viewTimestamp } from "../sql/values.js";
import { instrumentId, json, nullableTime, str } from "./fold-values.js";
import { INSTRUMENTS } from "./instruments.js";

const table: TableDef = {
  name: "alerts",
  columns: [
    { name: "instrument_id", type: "INTEGER", ref: "inv_instruments" },
    { name: "scope", type: "TEXT", notNull: true },
    { name: "kind", type: "TEXT", notNull: true },
    { name: "params", type: "TEXT", notNull: true, json: true },
    { name: "polarity", type: "TEXT", notNull: true, default: "'neutral'" },
    { name: "severity", type: "TEXT", notNull: true, default: "'info'" },
    { name: "title", type: "TEXT", notNull: true },
    { name: "note", type: "TEXT" },
    { name: "source", type: "TEXT", notNull: true, default: "'user'" },
    { name: "created_by", type: "TEXT", notNull: true, default: "'app'" },
    { name: "status", type: "TEXT", notNull: true, default: "'active'" },
    { name: "cooldown_days", type: "INTEGER" },
    { name: "expires_at", type: "TEXT" },
    { name: "snoozed_until", type: "TEXT" },
    { name: "last_triggered_at", type: "TEXT" },
    { name: "last_checked_at", type: "TEXT" },
    { name: "last_value", type: "TEXT" },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "updated_at", type: "TEXT", notNull: true },
    { name: "deleted_at", type: "TEXT" },
    { name: "tag", type: "TEXT" },
  ],
  indexes: [{ columns: ["instrument_id"] }, { columns: ["status"] }],
};

/** The owner and runtime registers behind `status`. */
const state: TableDef = {
  name: "fold_alert_state",
  primaryKey: ["gid"],
  internal: true,
  columns: [
    { name: "gid", type: "TEXT", notNull: true },
    { name: "owner_status", type: "TEXT", notNull: true },
    { name: "triggered", type: "INTEGER", notNull: true },
  ],
};

interface State {
  owner_status: string;
  triggered: number;
  snoozed_until: string | null;
}

function foldStatus(s: State): string {
  if (s.owner_status === "muted" || s.owner_status === "snoozed") return s.owner_status;
  return s.triggered === 1 ? "triggered" : "active";
}

function load(ctx: FoldContext, gid: string): State | undefined {
  return ctx.sql.get<State>(
    `SELECT s.owner_status, s.triggered, a.snoozed_until FROM fold_alert_state s
     JOIN alerts a ON a.gid = s.gid WHERE s.gid = ?`,
    gid,
  );
}

function save(
  ctx: FoldContext,
  gid: string,
  s: State,
  extra: string,
  ...params: (string | null)[]
) {
  ctx.sql.write(
    state.name,
    "UPDATE fold_alert_state SET owner_status = ?, triggered = ? WHERE gid = ?",
    s.owner_status,
    s.triggered,
    gid,
  );
  ctx.sql.write(
    table.name,
    `UPDATE alerts SET status = ?, snoozed_until = ?${extra} WHERE gid = ?`,
    foldStatus(s),
    s.snoozed_until,
    ...params,
    gid,
  );
}

const CONFIG = {
  title: "title",
  note: "note",
  polarity: "polarity",
  severity: "severity",
  cooldownDays: "cooldown_days",
  tag: "tag",
} as const;

export const alertsMaterializer: Materializer = {
  id: "investments.alerts",
  version: 2,
  tables: [table, state],
  handles: [
    "alert.created",
    "alert.updated",
    "alert.statusSet",
    "alert.deleted",
    "alert.restored",
    "alert.evaluated",
  ],
  identity: [INSTRUMENTS],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) {
      ctx.sql.write(table.name, "DELETE FROM alerts WHERE gid = ?", g);
      ctx.sql.write(state.name, "DELETE FROM fold_alert_state WHERE gid = ?", g);
    }
  },
  apply(e, ctx) {
    const d = e.data;
    const g = e.gid;
    ctx.members.add(g, g);
    if (e.type === "alert.created") {
      if (ctx.sql.get("SELECT 1 FROM fold_alert_state WHERE gid = ?", g)) return; // CREATE once
      ctx.sql.write(
        state.name,
        "INSERT INTO fold_alert_state (gid, owner_status, triggered) VALUES (?, 'active', 0)",
        g,
      );
      ctx.sql.write(
        table.name,
        `INSERT INTO alerts (id, gid, instrument_id, scope, kind, params, polarity, severity, title, note,
           source, created_by, status, cooldown_days, expires_at, snoozed_until, last_triggered_at,
           last_checked_at, last_value, created_at, updated_at, deleted_at, tag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, ?)`,
        ctx.id(g),
        g,
        instrumentId(ctx, d.instrument),
        String(d.scope),
        String(d.kind),
        json(restoreFloats(d.params ?? {}, d.paramsFloats)), // events.md 4.3
        String(d.polarity ?? "neutral"),
        String(d.severity ?? "info"),
        String(d.title),
        str(d.note),
        String(d.source ?? "user"),
        String(d.createdBy ?? "app"),
        typeof d.cooldownDays === "number" ? d.cooldownDays : null,
        nullableTime(e, "expires_at", d.expiresAt),
        ctx.time(e, "created_at"),
        ctx.time(e, "updated_at"),
        str(d.tag),
      );
      return;
    }
    const s = load(ctx, g);
    if (s === undefined) return; // parked: its create is not held
    switch (e.type) {
      case "alert.updated": {
        for (const [field, column] of Object.entries(CONFIG)) {
          if (!(field in d)) continue;
          const v = d[field];
          ctx.sql.write(
            table.name,
            `UPDATE alerts SET ${column} = ? WHERE gid = ?`,
            typeof v === "number" || typeof v === "string" ? v : null,
            g,
          );
        }
        if ("params" in d) {
          ctx.sql.write(
            table.name,
            "UPDATE alerts SET params = ? WHERE gid = ?",
            json(restoreFloats(d.params, d.paramsFloats)),
            g,
          );
        }
        if ("expiresAt" in d) {
          ctx.sql.write(
            table.name,
            "UPDATE alerts SET expires_at = ? WHERE gid = ?",
            nullableTime(e, "expires_at", d.expiresAt),
            g,
          );
        }
        ctx.sql.write(
          table.name,
          "UPDATE alerts SET updated_at = ? WHERE gid = ?",
          ctx.time(e, "updated_at"),
          g,
        );
        return;
      }
      case "alert.statusSet": {
        s.owner_status = String(d.status);
        s.snoozed_until = viewTimestamp(str(d.snoozedUntil));
        if (s.owner_status !== "active") s.triggered = 0;
        save(ctx, g, s, ", updated_at = ?", ctx.time(e, "updated_at"));
        return;
      }
      case "alert.deleted":
        ctx.sql.write(
          table.name,
          "UPDATE alerts SET deleted_at = ? WHERE gid = ?",
          ctx.time(e, "deleted_at"),
          g,
        );
        return;
      case "alert.restored": {
        if (d.rearm === true) s.triggered = 0;
        save(ctx, g, s, ", deleted_at = NULL, updated_at = ?", ctx.time(e, "updated_at"));
        return;
      }
      case "alert.evaluated": {
        const checked = nullableTime(e, "last_checked_at", d.lastCheckedAt);
        if (
          s.owner_status === "snoozed" &&
          checked !== null &&
          s.snoozed_until !== null &&
          checked >= s.snoozed_until
        ) {
          // The leader evaluated at or after the snooze end: it woke the alert (domain times only,
          // so the result does not depend on delivery order).
          s.owner_status = "active";
          s.snoozed_until = null;
        }
        s.triggered = d.triggered === true ? 1 : 0;
        const sets: string[] = [];
        const params: (string | null)[] = [];
        if ("lastCheckedAt" in d) {
          sets.push(", last_checked_at = ?");
          params.push(checked);
        }
        if ("lastValue" in d) {
          sets.push(", last_value = ?");
          params.push(str(d.lastValue));
        }
        if ("lastTriggeredAt" in d) {
          sets.push(", last_triggered_at = ?");
          params.push(nullableTime(e, "last_triggered_at", d.lastTriggeredAt));
        }
        save(ctx, g, s, sets.join(""), ...params);
        return;
      }
    }
  },
};
