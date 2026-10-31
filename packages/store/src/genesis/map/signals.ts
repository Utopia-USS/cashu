// Genesis row mappers, rule runs, alerts and signals (S26 spec 4.7, D-G5, D-G6; events.md 8.7, 11):
// the alert owner state split from its runtime state, rule runs with signal gids in their report,
// and the signals grouped by rewritten dedup key, closed episodes first (convergence-critical).

import { isJsonObject } from "../idFields.js";
import type { AlertRow, InvRuleRunRow, InvSignalRow } from "../invStateRows.js";
import { event, gidOf, type MapContext, type RowEvents, rowEvents, stampsOf } from "./context.js";

/** `ruleRun.finished`; a report without `new` / `escalated` lists gets empty ones (counted). */
export function mapRuleRun(r: InvRuleRunRow, ctx: MapContext): RowEvents | undefined {
  const t = "inv_rule_runs";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const report = ctx.rw.json(t, "report", r.report);
  const lists = isJsonObject(report) ? report : {};
  const missing = ["new", "escalated"].filter((k) => !Array.isArray(lists[k]));
  if (missing.length > 0) ctx.count(t, "report_lists_filled");
  const data = {
    trigger: r.trigger,
    asOf: r.asOf,
    status: r.status,
    strategyVersion: ctx.rw.ref(
      t,
      "strategy_version_id",
      "inv_strategy_versions",
      r.strategyVersionId,
    ),
    stats: ctx.rw.json(t, "stats", r.stats),
    errors: ctx.rw.json(t, "errors", r.errors),
    report: { ...lists, ...Object.fromEntries(missing.map((k) => [k, []])) },
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
  };
  return rowEvents(t, r.id, [
    event("ruleRun.finished", gid, data, stampsOf(r, ["startedAt", "finishedAt"])),
  ]);
}

/** Python `InvAlert.status` (models.py): every stored value genesis knows how to split. */
const ALERT_STATUSES: readonly string[] = ["active", "triggered", "snoozed", "muted", "expired"];
const ALERT_STAMPS = [
  "createdAt",
  "updatedAt",
  "expiresAt",
  "snoozedUntil",
  "lastTriggeredAt",
  "lastCheckedAt",
  "deletedAt",
] as const;

/**
 * `alert.created` (config), the owner status (`muted`, `snoozed` with its until; a snooze without
 * one stays active, counted `snooze_without_until`), the runtime state as `alert.evaluated`
 * (`triggered` included), and `alert.deleted`. `expired` is derived from `expiresAt` (D-G5).
 */
export function mapAlert(r: AlertRow, ctx: MapContext): RowEvents | undefined {
  const gid = gidOf(ctx, "alerts", r.id);
  if (gid === undefined) return undefined;
  if (!ALERT_STATUSES.includes(r.status)) {
    ctx.count("alerts", "bad_enum");
    return undefined;
  }
  const stamps = stampsOf(r, ALERT_STAMPS);
  const config = {
    instrument: ctx.rw.ref("alerts", "instrument_id", "inv_instruments", r.instrumentId),
    scope: r.scope,
    kind: r.kind,
    params: ctx.rw.json("alerts", "params", r.params),
    polarity: r.polarity,
    severity: r.severity,
    title: r.title,
    note: r.note,
    source: r.source,
    createdBy: r.createdBy,
    cooldownDays: r.cooldownDays,
    expiresAt: r.expiresAt,
  };
  const events = [event("alert.created", gid, config, stamps)];
  if (r.status === "muted") {
    events.push(event("alert.statusSet", gid, { status: "muted", snoozedUntil: null }, stamps));
  } else if (r.status === "snoozed" && r.snoozedUntil === null) {
    ctx.count("alerts", "snooze_without_until");
  } else if (r.status === "snoozed") {
    const status = { status: "snoozed", snoozedUntil: r.snoozedUntil };
    events.push(event("alert.statusSet", gid, status, stamps));
  }
  const runtime = r.lastCheckedAt !== null || r.lastValue !== null || r.lastTriggeredAt !== null;
  if (runtime || r.status === "triggered") {
    const evaluated = {
      triggered: r.status === "triggered",
      ...(r.lastCheckedAt === null ? {} : { lastCheckedAt: r.lastCheckedAt }),
      ...(r.lastValue === null ? {} : { lastValue: r.lastValue }),
      ...(r.lastTriggeredAt === null ? {} : { lastTriggeredAt: r.lastTriggeredAt }),
    };
    events.push(event("alert.evaluated", gid, evaluated, stamps));
  }
  if (r.deletedAt !== null) events.push(event("alert.deleted", gid, {}, stamps));
  return rowEvents("alerts", r.id, events);
}

/** A stored timestamp as a fixed-width sortable string (fraction padded to 6 digits). */
function sortable(ts: string): string {
  const m = /^(.{19})(?:\.(\d+))?Z$/.exec(ts);
  return m === null ? ts : `${m[1]}.${(m[2] ?? "").padEnd(6, "0")}`;
}

/**
 * D-G5: alerts stored `expired` that will not read expired after the fold (no `expires_at`, or one
 * after the genesis wall `wallIso`, the dataset's clock): counted `expired_without_expiry`.
 */
export function countExpiredWithoutExpiry(
  alerts: readonly AlertRow[],
  wallIso: string,
  ctx: Pick<MapContext, "count">,
): void {
  const wall = sortable(wallIso);
  const n = alerts.filter(
    (a) => a.status === "expired" && (a.expiresAt === null || sortable(a.expiresAt) > wall),
  ).length;
  ctx.count("alerts", "expired_without_expiry", n);
}

const CLOSED: readonly string[] = ["resolved", "expired"];
/** `domain.SignalStatus`: open (`active`, `acknowledged`) and closed. */
const SIGNAL_STATUSES: readonly string[] = ["active", "acknowledged", ...CLOSED];
const SIGNAL_STAMPS = [
  "firstSeenAt",
  "lastSeenAt",
  "acknowledgedAt",
  "closedAt",
  "snoozedUntil",
] as const;

/** One signal: `signal.opened` with its lifecycle (refreshed, snoozed, closed). */
function mapSignal(r: InvSignalRow, dedupKey: string, ctx: MapContext): RowEvents | undefined {
  const t = "inv_signals";
  const gid = gidOf(ctx, t, r.id);
  if (gid === undefined) return undefined;
  const stamps = stampsOf(r, SIGNAL_STAMPS);
  const opened = {
    ruleId: ctx.rw.ruleId(t, r.ruleId),
    kind: r.kind,
    dedupKey,
    severity: r.severity,
    polarity: r.polarity,
    message: r.message,
    instrument: ctx.rw.ref(t, "instrument_id", "inv_instruments", r.instrumentId),
    account: ctx.rw.ref(t, "account_id", "accounts", r.accountId),
    payload: ctx.rw.json(t, "payload", r.payload),
    run: ctx.rw.ref(t, "created_run_id", "inv_rule_runs", r.createdRunId),
  };
  const events = [event("signal.opened", gid, opened, stamps)];
  if (r.lastRunId !== r.createdRunId) {
    const run = ctx.rw.ref(t, "last_run_id", "inv_rule_runs", r.lastRunId);
    events.push(event("signal.refreshed", gid, { run, seenAt: r.lastSeenAt }, stamps));
  }
  if (r.snoozedUntil !== null) {
    events.push(event("signal.snoozed", gid, { until: r.snoozedUntil }, stamps));
  }
  if (CLOSED.includes(r.status)) {
    events.push(event("signal.closed", gid, { status: r.status, reason: "genesis" }, stamps));
  }
  return rowEvents(t, r.id, events);
}

/**
 * The signals of a vault in the order of spec 4.7 / events.md 11: grouped by rewritten dedup key,
 * keys in the order of their smallest signal id; within a key the closed signals by (closed_at, id),
 * each with its lifecycle, then the open one. Counts `ack_without_decision` (an acknowledged signal
 * no decision links, D-G6), `bad_duplicate_open` (two open signals of one key, R-G8) and `bad_enum`
 * (a status outside `domain.SignalStatus`, the signal skipped).
 */
export function mapSignals(
  signals: readonly InvSignalRow[],
  linked: ReadonlySet<number>,
  ctx: MapContext,
): RowEvents[] {
  const groups = new Map<string, { row: InvSignalRow; key: string }[]>();
  for (const row of [...signals].sort((a, b) => a.id - b.id)) {
    if (!SIGNAL_STATUSES.includes(row.status)) {
      ctx.count("inv_signals", "bad_enum");
      continue;
    }
    const key = ctx.rw.key("inv_signals", row.dedupKey);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [{ row, key }]);
    else group.push({ row, key });
    if (row.status === "acknowledged" && !linked.has(row.id)) {
      ctx.count("inv_signals", "ack_without_decision");
    }
  }
  const out: RowEvents[] = [];
  for (const group of groups.values()) {
    const closed = group.filter((s) => CLOSED.includes(s.row.status));
    const open = group.filter((s) => !CLOSED.includes(s.row.status));
    if (open.length > 1) ctx.count("inv_signals", "bad_duplicate_open", open.length - 1);
    closed.sort((a, b) => {
      const ca = a.row.closedAt === null ? "" : sortable(a.row.closedAt);
      const cb = b.row.closedAt === null ? "" : sortable(b.row.closedAt);
      return ca < cb ? -1 : ca > cb ? 1 : a.row.id - b.row.id;
    });
    for (const s of [...closed, ...open]) {
      const mapped = ctx.attempt(() => mapSignal(s.row, s.key, ctx));
      if (mapped !== undefined) out.push(mapped);
    }
  }
  return out;
}
