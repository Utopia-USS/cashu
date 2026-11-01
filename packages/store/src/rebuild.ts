// Rebuild (events.md 7.9): recompute the whole view from the held log. Used after an app upgrade
// (new event versions or materializers: the store does it on open), after a snapshot import from
// another version, and on demand. The result equals the incremental view (tested on every
// convergence scenario and on random event sets).

import type { LazyRefs, MaterializerRunner } from "./engine/fold.js";
import type { IdentityService } from "./engine/identity.js";
import { type EventLog, type LogRow, storedBody } from "./engine/log.js";
import { recomputeAllSuppression, type SuppressionRules } from "./engine/suppression.js";
import type { ViewSql } from "./engine/types.js";
import type { Decoded } from "./envelope.js";
import { decodeEnvelope } from "./envelope.js";
import type { DetGid } from "./gid.js";
import type { EventRegistry } from "./registry.js";
import type { SqlDriver } from "./sql/driver.js";

export interface RebuildContext {
  readonly driver: SqlDriver;
  readonly vault: string;
  readonly log: EventLog;
  readonly events: EventRegistry;
  readonly identity: IdentityService;
  readonly runners: readonly MaterializerRunner[];
  readonly suppression: SuppressionRules;
  readonly det: DetGid;
  readonly lazyRefs: LazyRefs;
  /** Writes through it are reported as touched. */
  readonly sql: ViewSql;
  /** The store's decoded-event -> log-row mapping (states, park reasons, gid checks). */
  readonly logRow: (
    decoded: Exclude<Decoded, { status: "rejected" }>,
    original: unknown,
  ) => Omit<LogRow, "seq">;
  /** Every deriver's full derivation, after the full re-fold (S24 4.1). */
  readonly deriveAll: (sql: ViewSql) => void;
}

/**
 * Run inside one transaction. `redecode` re-validates every stored event against the current
 * registry (parked ones are always retried); `reindex` recomputes the event refs.
 */
export function rebuildView(
  ctx: RebuildContext,
  options: { readonly redecode?: boolean; readonly reindex?: boolean },
): void {
  redecode(ctx, options.redecode === true);
  ctx.driver.exec(
    "DELETE FROM materializer_state; DELETE FROM identity_roots; DELETE FROM identity_accepted;",
  );
  // view_ids stay: ids are view-local and stable, and keeping them spares a lookup per row.
  recomputeAllSuppression(ctx.log, ctx.suppression);
  if (options.redecode === true || options.reindex === true) reindexRefs(ctx);
  ctx.identity.recompute(ctx.log, ctx.sql, true);
  for (const r of ctx.runners) r.refoldAll(ctx.sql);
  ctx.deriveAll(ctx.sql);
}

/** Re-decode parked events (always) and every event (after a registry change). */
function redecode(ctx: RebuildContext, all: boolean): void {
  const rows = ctx.driver
    .prepare(`SELECT * FROM event_log ${all ? "" : "WHERE state = 'parked'"}`)
    .all<LogRow>();
  const update = ctx.driver.prepare(
    "UPDATE event_log SET state = ?, reason = ?, raw_data = ?, data = ? WHERE eid = ?",
  );
  for (const row of rows) {
    const raw = JSON.parse(storedBody(row, ctx.vault)) as Record<string, unknown>;
    const decoded = decodeEnvelope(raw, ctx.events);
    if (decoded.status === "rejected") continue; // a stored envelope passed validation once
    const next = ctx.logRow(decoded, raw.data);
    update.run(next.state, next.reason, next.raw_data, next.data, row.eid);
  }
  ctx.sql.write("unknown_events", "DELETE FROM unknown_events");
  for (const r of ctx.driver
    .prepare(
      "SELECT type, v, reason, COUNT(*) AS n FROM event_log WHERE state = 'parked' GROUP BY type, v, reason",
    )
    .all<{ type: string; v: number; reason: string; n: number }>()) {
    ctx.sql.write(
      "unknown_events",
      "INSERT INTO unknown_events (type, v, reason, count) VALUES (?, ?, ?, ?)",
      r.type,
      r.v,
      r.reason,
      r.n,
    );
  }
}

/** Recompute `event_refs` for every held event (refs are a function of the log + materializers). */
function reindexRefs(ctx: RebuildContext): void {
  ctx.driver.exec("DELETE FROM event_refs");
  ctx.lazyRefs.reset(); // on-demand refs are indexed again when first asked
  const byType = new Map<string, MaterializerRunner[]>();
  for (const r of ctx.runners) {
    if (!r.mat.refs || r.mat.refsOnDemand === true) continue;
    for (const t of r.mat.handles) byType.set(t, [...(byType.get(t) ?? []), r]);
  }
  for (const e of ctx.log.heldOfTypes([...byType.keys()])) {
    for (const r of byType.get(e.type) ?? []) {
      for (const s of r.mat.refs?.(e, ctx.det) ?? []) ctx.log.addRef(s, e.eid);
    }
  }
}
