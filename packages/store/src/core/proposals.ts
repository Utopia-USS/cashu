// Proposals (events.md 8.10): CREATE; terminal transitions are first-writer-wins. The engine's
// suppression stage already turned FWW losers (and their caused side effects) into suppressed
// events, so the applied terminal is the winner. A rejection stores its note as the result
// (`{note}`, `{}` without one: Python `reject`). `proposal.applyFailed` (S31c) is the execution
// result after the decision: approved -> failed with its result, review time kept (Python `_finish`),
// a no-op unless the row is approved; the engine revokes what the approval caused (events.md 6.6).
import type { Materializer } from "../engine/types.js";
import type { TableDef } from "../sql/ddl.js";
import { sqlJson } from "../sql/values.js";

const table: TableDef = {
  name: "proposals",
  columns: [
    { name: "kind", type: "TEXT", notNull: true },
    { name: "status", type: "TEXT", notNull: true, default: "'pending'" },
    { name: "summary", type: "TEXT", notNull: true, default: "''" },
    { name: "reason", type: "TEXT" },
    { name: "payload", type: "TEXT", notNull: true, json: true },
    { name: "result", type: "TEXT", notNull: true, json: true },
    { name: "source", type: "TEXT", notNull: true },
    { name: "created_at", type: "TEXT", notNull: true },
    { name: "reviewed_at", type: "TEXT" },
  ],
};

export const proposalsMaterializer: Materializer = {
  id: "core.proposals",
  version: 2,
  tables: [table],
  handles: [
    "proposal.created",
    "proposal.approved",
    "proposal.rejected",
    "proposal.failed",
    "proposal.applyFailed",
  ],
  partitions: (e) => [e.gid],
  clear(gids, ctx) {
    for (const g of gids) ctx.sql.write(table.name, "DELETE FROM proposals WHERE gid = ?", g);
  },
  apply(e, ctx) {
    const d = e.data;
    if (e.type === "proposal.created") {
      ctx.sql.write(
        table.name,
        `INSERT OR IGNORE INTO proposals (id, gid, kind, status, summary, reason, payload, result, source, created_at)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, '{}', ?, ?)`,
        ctx.id(e.gid),
        e.gid,
        String(d.kind),
        String(d.summary ?? ""),
        (d.reason as string | null) ?? null,
        sqlJson(d.payload ?? {}),
        String(d.source),
        ctx.time(e, "created_at"),
      );
      return;
    }
    if (e.type === "proposal.applyFailed") {
      ctx.sql.write(
        table.name,
        "UPDATE proposals SET status = 'failed', result = ? WHERE gid = ? AND status = 'approved'",
        sqlJson(d.result ?? {}),
        e.gid,
      );
      return;
    }
    const status = e.type.slice("proposal.".length);
    const note = typeof d.note === "string" && d.note !== "" ? d.note : null;
    const result =
      e.type === "proposal.rejected"
        ? sqlJson(note === null ? {} : { note })
        : "result" in d
          ? sqlJson(d.result)
          : null;
    ctx.sql.write(
      table.name,
      `UPDATE proposals SET status = ?, result = COALESCE(?, result), reviewed_at = ?
       WHERE gid = ? AND status = 'pending'`,
      status,
      result,
      ctx.time(e, "reviewed_at"),
      e.gid,
    );
  },
};
