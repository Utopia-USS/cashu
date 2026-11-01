// Rebuild (events.md 7.9, M10): recompute the view from the held log. Used after an app upgrade
// (new event versions, materializer / identity / deriver versions or view DDL: the store does it on
// open, `planViewUpgrade` decides what), after a snapshot import from another version, and on demand.
// The result equals the incremental view (tested on every convergence scenario and on random event
// sets) and, after an upgrade, the view a reader new from the start folds (`upgrade.test.ts`).
//
// Upgrade rule (what an open after an app update rebuilds), from the recorded `ViewDefs`:
//   - WHOLE VIEW when the event registry changed (every stored event is re-decoded: states,
//     suppression, identity and every fold may change), when the database records no per-component
//     definitions, when an identity kind changed (its resolution keys rows of many materializers),
//     when a deriver was removed (what it wrote cannot be told apart any more), or when a changed,
//     added or removed materializer indexes event refs (refs feed `referrers` and partition
//     closures of every materializer handling the same types).
//   - Otherwise ONLY the changed and added materializers are re-folded from the log (a fold reads
//     nothing but the applied events and the identity resolution, both unchanged), removed ones are
//     dropped, and the derivers that can see a difference run `deriveAll` in registry order: a changed
//     or added deriver, one that inputs a re-folded materializer, one that writes a table re-folded
//     or written by an earlier rebuilt deriver (or inputs that table's materializer), and one that
//     inputs `CONTRIBUTIONS` when a contribution reads such a table.
// The upgrade runs in ONE transaction with the DDL and the new definitions record: a crash mid-way
// rolls everything back, so the next open finds the old record and starts the rebuild again; a
// half-rebuilt view is never committed, so never served.

import type { LazyRefs, MaterializerRunner } from "./engine/fold.js";
import type { IdentityService } from "./engine/identity.js";
import { type EventLog, type LogRow, storedBody } from "./engine/log.js";
import { recomputeAllSuppression, type SuppressionRules } from "./engine/suppression.js";
import { CONTRIBUTIONS, type DeriveContext, type Deriver, type ViewSql } from "./engine/types.js";
import type { Decoded } from "./envelope.js";
import { decodeEnvelope } from "./envelope.js";
import type { DetGid } from "./gid.js";
import {
  type ComponentDef,
  componentKey,
  type EventRegistry,
  type ModuleRegistry,
  type ViewDefs,
} from "./registry.js";
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
  /** The registered derivers, in registry order, and their context on a `ViewSql`. */
  readonly derivers: readonly Deriver[];
  readonly deriveContext: (sql: ViewSql) => DeriveContext;
  readonly onProgress?: RebuildListener | undefined;
}

export type RebuildScope = "full" | "partial";

/**
 * Why a rebuild ran: `manual` (`Store.rebuild`), `events` (the event registry changed), `unrecorded`
 * (the database records no per-component definitions), `identity`, `refs`, `deriver-removed` (the
 * whole-view cases of the upgrade rule above) or `definitions` (only materializers / derivers
 * changed: a partial rebuild).
 */
export type RebuildReason =
  | "manual"
  | "events"
  | "unrecorded"
  | "identity"
  | "refs"
  | "deriver-removed"
  | "definitions";

export interface RebuildReport {
  readonly scope: RebuildScope;
  readonly reason: RebuildReason;
  /** Materializers re-folded (every one on a full rebuild). */
  readonly materializers: readonly string[];
  /** Derivers that ran `deriveAll`. */
  readonly derivers: readonly string[];
  /** Public view tables the rebuild rewrote (the useQuery invalidation set). */
  readonly touchedTables: ReadonlySet<string>;
}

/**
 * Progress of a rebuild, for the UI ("updating your data", events.md 7.9). Called synchronously
 * inside the rebuild transaction (a listener that throws aborts and rolls back the rebuild):
 * `start` with the step names, `step` when one begins, `fold` every few thousand events of a
 * materializer's re-fold, `done` after the commit with the report.
 */
export type RebuildProgress =
  | {
      readonly phase: "start";
      readonly scope: RebuildScope;
      readonly reason: RebuildReason;
      readonly steps: readonly string[];
    }
  | { readonly phase: "step"; readonly step: string; readonly index: number }
  | {
      readonly phase: "fold";
      readonly step: string;
      readonly folded: number;
      readonly total: number;
    }
  | { readonly phase: "done"; readonly report: RebuildReport };

export type RebuildListener = (progress: RebuildProgress) => void;

/** What an open after a definitions change rebuilds (see the upgrade rule at the top). */
export interface ViewUpgradePlan {
  readonly scope: RebuildScope;
  readonly reason: RebuildReason;
  /** Re-decode every stored event (the event registry changed). */
  readonly redecode: boolean;
  /** Materializers to re-fold (every registered one on a full rebuild). */
  readonly materializers: readonly string[];
  /** Derivers to run `deriveAll`, in registry order. */
  readonly derivers: readonly string[];
  /** Materializers no longer registered: their fold state is deleted. */
  readonly removed: readonly string[];
  /** Tables to drop before the rebuild (recorded names) ... */
  readonly drop: readonly string[];
  /** ... and current tables to create (empty) after the drop. */
  readonly create: readonly string[];
}

/**
 * Decide what to rebuild after the definitions changed. `stored` is the database's record
 * (undefined: none), `previousTables` every view table the database holds by the store's own list.
 */
export function planViewUpgrade(input: {
  readonly registry: ModuleRegistry;
  readonly stored: ViewDefs | undefined;
  readonly previousTables: readonly string[];
  readonly eventsChanged: boolean;
  readonly viewChanged: boolean;
}): ViewUpgradePlan {
  const { registry, stored } = input;
  const current = registry.viewDefs();
  const allCurrent = registry.viewTables().map((t) => t.name);
  const full = (reason: RebuildReason): ViewUpgradePlan => ({
    scope: "full",
    reason,
    redecode: input.eventsChanged,
    materializers: registry.materializers.map((m) => m.id),
    derivers: registry.derivers.map((d) => d.id),
    removed: [],
    drop: input.viewChanged
      ? unique([...input.previousTables, ...Object.values(stored ?? {}).flatMap((c) => c.tables)])
      : [],
    create: input.viewChanged ? allCurrent : [],
  });
  if (input.eventsChanged) return full("events");
  if (stored === undefined) return full("unrecorded");

  const changed = new Set<string>();
  const removed = new Set<string>();
  for (const [key, def] of Object.entries(current)) {
    const old = stored[key];
    if (old === undefined || !sameDef(old, def)) changed.add(key);
  }
  for (const key of Object.keys(stored)) if (current[key] === undefined) removed.add(key);
  const kindOf = (key: string) => key.slice(0, key.indexOf(":"));
  const idOf = (key: string) => key.slice(key.indexOf(":") + 1);
  if ([...changed, ...removed].some((k) => kindOf(k) === "identity")) return full("identity");
  if ([...removed].some((k) => kindOf(k) === "deriver")) return full("deriver-removed");
  const withRefs = (k: string) => stored[k]?.refs !== undefined || current[k]?.refs !== undefined;
  if ([...changed, ...removed].some((k) => kindOf(k) === "materializer" && withRefs(k))) {
    return full("refs");
  }

  const refold = registry.materializers.filter((m) =>
    changed.has(componentKey("materializer", m.id)),
  );
  const refoldIds = new Set(refold.map((m) => m.id));
  const ownerOf = new Map(
    registry.materializers.flatMap((m) => m.tables.map((t) => [t.name, m.id])),
  );
  const dirtyTables = new Set(refold.flatMap((m) => m.tables.map((t) => t.name)));
  const derivers: string[] = [];
  for (const d of registry.derivers) {
    const writes = d.writes.map((w) => w.table);
    const affected =
      changed.has(componentKey("deriver", d.id)) ||
      d.inputs.some((i) => refoldIds.has(i)) ||
      writes.some((t) => dirtyTables.has(t)) ||
      [...dirtyTables].some((t) => d.inputs.includes(ownerOf.get(t) ?? "")) ||
      (d.inputs.includes(CONTRIBUTIONS) &&
        registry.contributions.some((c) => c.reads.some((t) => dirtyTables.has(t))));
    if (!affected) continue;
    derivers.push(d.id);
    for (const t of writes) dirtyTables.add(t);
  }
  // Recreated empty: the tables of every changed component (a version-only bump too: its re-fold or
  // `deriveAll` starts from empty tables either way); dropped: their recorded names and the removed
  // ones'.
  const rebuilt = [...changed];
  return {
    scope: "partial",
    reason: "definitions",
    redecode: false,
    materializers: refold.map((m) => m.id),
    derivers,
    removed: [...removed].filter((k) => kindOf(k) === "materializer").map(idOf),
    drop: unique([...rebuilt, ...removed].flatMap((k) => stored[k]?.tables ?? [])),
    create: rebuilt.flatMap((k) => current[k]?.tables ?? []),
  };
}

function sameDef(a: ComponentDef, b: ComponentDef): boolean {
  return a.version === b.version && a.ddl === b.ddl && a.refs === b.refs && a.at === b.at;
}

function unique(xs: readonly string[]): string[] {
  return [...new Set(xs)];
}

/** Reports progress steps to the listener (no-op without one). */
class Steps {
  readonly #listener: RebuildListener | undefined;
  #index = 0;

  constructor(
    listener: RebuildListener | undefined,
    scope: RebuildScope,
    reason: RebuildReason,
    steps: readonly string[],
  ) {
    this.#listener = listener;
    listener?.({ phase: "start", scope, reason, steps });
  }

  step(step: string): void {
    this.#listener?.({ phase: "step", step, index: this.#index++ });
  }

  /** The `onFold` callback of a materializer's re-fold. */
  fold(step: string): ((folded: number, total: number) => void) | undefined {
    const l = this.#listener;
    return l ? (folded, total) => l({ phase: "fold", step, folded, total }) : undefined;
  }
}

/**
 * Run inside one transaction. `redecode` re-validates every stored event against the current
 * registry (parked ones are always retried); `reindex` recomputes the event refs.
 */
export function rebuildView(
  ctx: RebuildContext,
  options: {
    readonly redecode?: boolean;
    readonly reindex?: boolean;
    readonly reason?: RebuildReason;
  },
): Omit<RebuildReport, "touchedTables"> {
  const reindex = options.redecode === true || options.reindex === true;
  const steps = new Steps(ctx.onProgress, "full", options.reason ?? "manual", [
    "decode",
    "suppression",
    ...(reindex ? ["refs"] : []),
    "identity",
    ...ctx.runners.map((r) => `fold:${r.mat.id}`),
    ...ctx.derivers.map((d) => `derive:${d.id}`),
  ]);
  steps.step("decode");
  redecode(ctx, options.redecode === true);
  ctx.driver.exec(
    "DELETE FROM materializer_state; DELETE FROM identity_roots; DELETE FROM identity_accepted;",
  );
  // view_ids stay: ids are view-local and stable, and keeping them spares a lookup per row.
  steps.step("suppression");
  recomputeAllSuppression(ctx.log, ctx.suppression);
  if (reindex) {
    steps.step("refs");
    reindexRefs(ctx);
  }
  steps.step("identity");
  ctx.identity.recompute(ctx.log, ctx.sql, true);
  for (const r of ctx.runners) {
    steps.step(`fold:${r.mat.id}`);
    r.refoldAll(ctx.sql, undefined, steps.fold(`fold:${r.mat.id}`));
  }
  derive(ctx, ctx.derivers, steps);
  return {
    scope: "full",
    reason: options.reason ?? "manual",
    materializers: ctx.runners.map((r) => r.mat.id),
    derivers: ctx.derivers.map((d) => d.id),
  };
}

/**
 * The partial half of an upgrade (run inside the upgrade transaction, after the plan's DDL): re-fold
 * the plan's materializers from the log, drop the fold state of removed ones, run the plan's
 * derivers. Suppression, identity, refs and every other materializer stay as they are.
 */
export function rebuildPartial(
  ctx: RebuildContext,
  plan: ViewUpgradePlan,
): Omit<RebuildReport, "touchedTables"> {
  const mats = new Set(plan.materializers);
  const runners = ctx.runners.filter((r) => mats.has(r.mat.id));
  const ders = new Set(plan.derivers);
  const derivers = ctx.derivers.filter((d) => ders.has(d.id));
  const steps = new Steps(ctx.onProgress, "partial", plan.reason, [
    ...runners.map((r) => `fold:${r.mat.id}`),
    ...derivers.map((d) => `derive:${d.id}`),
  ]);
  const drop = ctx.driver.prepare("DELETE FROM materializer_state WHERE id = ?");
  for (const id of plan.removed) drop.run(id);
  for (const r of runners) {
    steps.step(`fold:${r.mat.id}`);
    r.refoldAll(ctx.sql, undefined, steps.fold(`fold:${r.mat.id}`));
  }
  derive(ctx, derivers, steps);
  return {
    scope: "partial",
    reason: plan.reason,
    materializers: runners.map((r) => r.mat.id),
    derivers: derivers.map((d) => d.id),
  };
}

/** `deriveAll` of `derivers` in registry order (each sees the previous ones' writes). */
function derive(ctx: RebuildContext, derivers: readonly Deriver[], steps: Steps): void {
  const dctx = ctx.deriveContext(ctx.sql);
  for (const d of derivers) {
    steps.step(`derive:${d.id}`);
    d.deriveAll(dctx);
    ctx.sql.flush();
  }
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
