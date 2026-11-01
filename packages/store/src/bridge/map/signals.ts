// TRANSITIONAL(S49): the sync bridge exists only while the Python app writes (S31a spec 2.1).
//
// Bridges of rule runs, alerts and signals (S31a spec 4.4 table; events.md 8.7, 11; S25-python-emits).
// Inserts are the genesis snapshot (`mapRuleRun`, `mapAlert`, `mapSignals`); updates take every
// payload field from the genesis snapshot of `post` (and of `pre` for the old payload):
// - alerts: config columns -> `alert.updated` (changed fields); owner status -> `alert.statusSet`;
//   `deleted_at` X -> null -> `alert.restored` (`rearm` with triggered -> active in the same row);
//   runtime (`last_*`, triggered <-> active alone) -> `alert.evaluated` (leader); -> X `alert.deleted`;
// - signals: a severity rank up -> `signal.escalated` (`reactivate` from P-C's kept prev status),
//   other refresh columns -> `signal.refreshed`; open -> closed -> `signal.closed {reason,
//   payloadSet}`; closed -> open -> `signal.reopened {payloadUnset}`; `snoozed_until` ->
//   `signal.snoozed`, or `signal.woken` (leader) when an expired snooze is cleared.
import { canonicalJson } from "../../canonical.js";
import type { EventType } from "../../events/v1/catalog.js";
import { isJsonObject } from "../../genesis/idFields.js";
import type { AlertRow, InvRuleRunRow, InvSignalRow } from "../../genesis/invStateRows.js";
import type { EventDraft, MapContext } from "../../genesis/map/context.js";
import { mapAlert, mapRuleRun, mapSignals } from "../../genesis/map/signals.js";
import {
  anyChanged,
  BridgeBlock,
  carried,
  derived,
  eventsOf,
  fieldsOf,
  pick,
  type RowChange,
  type TableBridge,
} from "./types.js";

/** A change of a column the catalog has no update event for: block, never ship it half. */
function refuseChanged(change: RowChange<unknown>, table: string, columns: readonly string[]) {
  for (const c of columns) {
    if (change.changed.has(c)) throw new BridgeBlock(`immutable:${table}:${c}`);
  }
}

// ----------------------------------------------------------------------------------------------- //
// Rule runs

const ruleRuns: TableBridge<InvRuleRunRow> = {
  table: "inv_rule_runs",
  gid: "ulid",
  columns: {
    ...carried(
      ["ruleRun.finished"],
      "id",
      "profile_id",
      "trigger",
      "as_of",
      "status",
      "strategy_version_id",
      "stats",
      "errors",
      "report",
      "started_at",
      "finished_at",
    ),
  },
  insert: (c, ctx) =>
    eventsOf(
      "inv_rule_runs",
      ctx.attempt(() => mapRuleRun(need(c.post), ctx)),
    ),
};

// ----------------------------------------------------------------------------------------------- //
// Alerts

/** Python column -> `alert.updated` patch field. */
const ALERT_CONFIG: readonly (readonly [string, string])[] = [
  ["title", "title"],
  ["note", "note"],
  ["params", "params"],
  ["polarity", "polarity"],
  ["severity", "severity"],
  ["cooldown_days", "cooldownDays"],
  ["expires_at", "expiresAt"],
];
const ALERT_RUNTIME = ["last_triggered_at", "last_checked_at", "last_value"];
const OWNER_STATUSES: readonly string[] = ["muted", "snoozed"];

function need<R>(row: R | undefined): R {
  if (row === undefined) throw new BridgeBlock("decode");
  return row;
}

function alertSnapshot(row: AlertRow, ctx: MapContext): readonly EventDraft[] {
  return eventsOf(
    "alerts",
    ctx.attempt(() => mapAlert(row, ctx)),
  );
}

function alertUpdate(c: RowChange<AlertRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "alerts", ["instrument_id", "scope", "kind", "source", "created_by", "tag"]);
  const post = need(c.post);
  const pre = need(c.pre);
  const snap = alertSnapshot(post, ctx);
  const created = pick("alerts", snap, "alert.created");
  const out: EventDraft[] = [];
  const config = ALERT_CONFIG.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  if (config.length > 0) {
    out.push(derived(created, "alert.updated", fieldsOf(created.data, config)));
  }
  const restoring = pre.deletedAt !== null && post.deletedAt === null;
  const rearm = restoring && pre.status === "triggered" && post.status === "active";
  if (restoring) out.push(derived(created, "alert.restored", rearm ? { rearm: true } : {}));
  const statusChanged = c.changed.has("status") && pre.status !== post.status;
  const ownerStatus =
    OWNER_STATUSES.includes(post.status) ||
    (post.status === "active" && OWNER_STATUSES.includes(pre.status));
  const snoozeMoved = c.changed.has("snoozed_until") && post.status === "snoozed";
  if ((statusChanged && ownerStatus) || snoozeMoved) {
    const status = post.status === "active" ? "active" : post.status;
    const snoozedUntil = status === "snoozed" ? post.snoozedUntil : null;
    if (status === "snoozed" && snoozedUntil === null) {
      ctx.count("alerts", "snooze_without_until");
    } else {
      out.push(derived(created, "alert.statusSet", { status, snoozedUntil }));
    }
  }
  const runtimeStatus =
    statusChanged &&
    !ownerStatus &&
    !rearm &&
    post.status !== "expired" &&
    pre.status !== "expired";
  if (runtimeStatus || anyChanged(c, ...ALERT_RUNTIME)) {
    const evaluated = snap.find((e) => e.type === "alert.evaluated");
    out.push(
      evaluated ?? derived(created, "alert.evaluated", { triggered: post.status === "triggered" }),
    );
  }
  if (pre.deletedAt === null && post.deletedAt !== null) {
    out.push(derived(created, "alert.deleted", {}));
  }
  return out;
}

const alerts: TableBridge<AlertRow> = {
  table: "alerts",
  gid: "ulid",
  columns: {
    ...carried(
      ["alert.created"],
      "id",
      "profile_id",
      "instrument_id",
      "scope",
      "kind",
      "source",
      "created_by",
      "created_at",
    ),
    ...carried(["alert.created", "alert.updated"], ...ALERT_CONFIG.map(([col]) => col)),
    ...carried(["alert.statusSet", "alert.evaluated", "alert.restored"], "status"),
    ...carried(["alert.statusSet"], "snoozed_until"),
    ...carried(["alert.evaluated"], ...ALERT_RUNTIME),
    ...carried(["alert.deleted", "alert.restored"], "deleted_at"),
    // TRANSITIONAL(S16): set or changed, it blocks the row (insert / update above); never shipped half.
    tag: { notShipped: "no catalog field yet (S16); a tagged alert blocks the loop (D4)" },
  },
  insert: (c, ctx) => {
    // TRANSITIONAL(S16): the catalog has no alert tag yet; a tagged alert blocks like genesis refuses.
    if (c.row.post?.tag !== null && c.row.post?.tag !== undefined) {
      throw new BridgeBlock("unsupported:alerts:tag");
    }
    return alertSnapshot(need(c.post), ctx);
  },
  update: alertUpdate,
};

// ----------------------------------------------------------------------------------------------- //
// Signals

const RANK: Readonly<Record<string, number>> = { info: 0, action: 1 };
const CLOSED: readonly string[] = ["resolved", "expired"];
/** Python column -> optional refresh field of `signal.refreshed` / `signal.escalated`. */
const REFRESH_OPTIONAL: readonly (readonly [string, string])[] = [
  ["rule_id", "ruleId"],
  ["kind", "kind"],
  ["polarity", "polarity"],
  ["instrument_id", "instrument"],
  ["account_id", "account"],
];
/** Generic close reason of a rule outcome (no `closed_by` / `closed_reason` in the payload). */
const RULE_CLOSE_REASON = "rule";

function signalSnapshot(row: InvSignalRow, ctx: MapContext): readonly EventDraft[] {
  const mapped = mapSignals([row], new Set(), ctx)[0];
  if (mapped === undefined) throw new BridgeBlock("unresolved:inv_signals");
  return mapped.events;
}

const payloadOf = (opened: EventDraft): Readonly<Record<string, unknown>> => {
  const p = opened.data.payload;
  return isJsonObject(p) ? p : {};
};

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);

function closeReason(payload: Readonly<Record<string, unknown>>): string {
  for (const key of ["closed_by", "closed_reason"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return RULE_CLOSE_REASON;
}

function signalUpdate(c: RowChange<InvSignalRow>, ctx: MapContext): readonly EventDraft[] {
  refuseChanged(c, "inv_signals", ["dedup_key", "first_seen_at", "created_run_id"]);
  const post = need(c.post);
  const pre = need(c.pre);
  const opened = pick("inv_signals", signalSnapshot(post, ctx), "signal.opened");
  const preOpened = pick("inv_signals", signalSnapshot(pre, ctx), "signal.opened");
  const postPayload = payloadOf(opened);
  const prePayload = payloadOf(preOpened);
  const closing = !CLOSED.includes(pre.status) && CLOSED.includes(post.status);
  const reopening = CLOSED.includes(pre.status) && !CLOSED.includes(post.status);
  const out: EventDraft[] = [];

  // Refresh / escalation (the payload of a close or reopen travels in payloadSet / payloadUnset).
  const payloadIsRefresh = c.changed.has("payload") && !closing && !reopening;
  const runIsRefresh = c.changed.has("last_run_id") && !closing;
  const optional = REFRESH_OPTIONAL.filter(([col]) => c.changed.has(col)).map(([, key]) => key);
  const escalation = (RANK[post.severity] ?? 0) > (RANK[pre.severity] ?? 0);
  const refresh =
    escalation ||
    payloadIsRefresh ||
    runIsRefresh ||
    optional.length > 0 ||
    anyChanged(c, "severity", "message", "last_seen_at");
  // The snapshot's `run` is created_run_id; a refresh, escalation or close carries last_run_id.
  const lastRun = ctx.rw.ref("inv_signals", "last_run_id", "inv_rule_runs", post.lastRunId);
  if (refresh) {
    const tail = { run: lastRun, seenAt: post.lastSeenAt, ...fieldsOf(opened.data, optional) };
    if (escalation) {
      const reactivate = pre.status === "acknowledged" && post.status === "active";
      const head = { severity: post.severity, message: post.message, payload: postPayload };
      out.push(derived(opened, "signal.escalated", { ...head, reactivate, ...tail }));
    } else {
      const head = {
        ...(c.changed.has("severity") ? { severity: post.severity } : {}),
        ...(c.changed.has("message") ? { message: post.message } : {}),
        ...(payloadIsRefresh ? { payload: postPayload } : {}),
      };
      out.push(derived(opened, "signal.refreshed", { ...head, ...tail }));
    }
  }

  if (c.changed.has("snoozed_until")) {
    const expired =
      post.snoozedUntil === null &&
      pre.snoozedUntil !== null &&
      pre.snoozedUntil <= `${c.row.ts.replace(" ", "T")}Z`;
    if (expired) out.push(derived(opened, "signal.woken", { until: pre.snoozedUntil }));
    else out.push(derived(opened, "signal.snoozed", { until: post.snoozedUntil }));
  }

  if (closing) {
    const payloadSet: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(postPayload)) {
      if (!(k in prePayload) || !same(prePayload[k], v)) payloadSet[k] = v;
    }
    out.push(
      derived(opened, "signal.closed", {
        status: post.status,
        reason: closeReason(postPayload),
        ...(c.changed.has("last_run_id") ? { run: lastRun } : {}),
        ...(Object.keys(payloadSet).length > 0 ? { payloadSet } : {}),
      }),
    );
  } else if (reopening) {
    const unset = Object.keys(prePayload).filter((k) => !(k in postPayload));
    const reason = typeof prePayload.closed_by === "string" ? "alert_restored" : "note_restored";
    out.push(
      derived(opened, "signal.reopened", {
        reason,
        ...(unset.length > 0 ? { payloadUnset: unset } : {}),
      }),
    );
  }
  return out;
}

const REFRESH_EVENTS: readonly EventType[] = ["signal.refreshed", "signal.escalated"];

const signals: TableBridge<InvSignalRow> = {
  table: "inv_signals",
  gid: "ulid",
  columns: {
    ...carried(
      ["signal.opened"],
      "id",
      "profile_id",
      "dedup_key",
      "first_seen_at",
      "created_run_id",
    ),
    ...carried(
      ["signal.opened", ...REFRESH_EVENTS],
      "rule_id",
      "kind",
      "severity",
      "message",
      "instrument_id",
      "account_id",
      "polarity",
    ),
    ...carried(["signal.opened", ...REFRESH_EVENTS, "signal.closed", "signal.reopened"], "payload"),
    ...carried([...REFRESH_EVENTS], "last_seen_at"),
    ...carried([...REFRESH_EVENTS, "signal.closed"], "last_run_id"),
    ...carried(["signal.closed", "signal.reopened"], "status", "closed_at"),
    ...carried(["signal.snoozed", "signal.woken"], "snoozed_until"),
  },
  insert: (c, ctx) => signalSnapshot(need(c.post), ctx),
  update: signalUpdate,
};

export const signalsBridges: readonly TableBridge[] = [ruleRuns, alerts, signals];
