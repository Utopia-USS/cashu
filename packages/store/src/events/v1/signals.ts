// Signals, rule runs and alerts payloads (events.md 8.7).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import { calendarDate, gid, jsonObject, nonEmpty, timestamp } from "./primitives.js";

export const SIGNAL_SEVERITIES = ["info", "action"] as const;
export const POLARITIES = ["positive", "negative", "neutral"] as const;
export const SIGNAL_CLOSE_STATUSES = ["resolved", "expired"] as const;
/** Owner-caused close reasons any device may emit (Python: payload.closed_by). */
export const OWNER_CLOSE_REASONS = ["snooze", "mute", "delete", "alert_expired"] as const;
export const RULE_RUN_TRIGGERS = ["worker", "api", "cli"] as const;
export const RULE_RUN_STATUSES = ["ok", "partial", "failed"] as const;
export const ALERT_SCOPES = ["instrument", "portfolio", "bucket"] as const;
export const ALERT_KINDS = [
  "price_above",
  "price_below",
  "change_pct",
  "drawdown_from_high",
  "new_high",
  "sma_cross",
  "weight_above",
  "weight_below",
  "custom",
  "range_breakout",
  "volume_spike",
] as const;
/** Owner-settable alert states; triggered / expired are runtime or time-derived (events.md 8.7). */
export const ALERT_OWNER_STATUSES = ["active", "muted", "snoozed"] as const;
export const ALERT_SOURCES = ["user", "agent"] as const;
export const ALERT_CREATORS = ["app", "cli", "mcp"] as const;

/**
 * A v2 dedup key (gid.md section 5 and 6): `<rule>[|i:<gid>][|a:<gid>][|s:<scope>]`,
 * `plan:<check>|i:<gid>`, `research:<week>|i:<gid>|s:..|t:..`, `alert:<gid>`. An `i:` / `a:` /
 * `alert:` part holding a bare integer is a local id that leaked: rejected.
 */
export const dedupKeyV2 = z
  .string()
  .min(1)
  .refine((k) => !/(^|\|)(i|a):\d+(\||$)/.test(k) && !/^alert:\d+$/.test(k), {
    message: "dedup key embeds a local integer id (gid.md section 6)",
  });

const ruleId = z
  .string()
  .min(1)
  .refine((k) => !/^alert:\d+$/.test(k), { message: "alert rule id embeds a local id" });

export const signalsEvents = {
  "signal.opened": payload({
    ruleId,
    kind: nonEmpty,
    dedupKey: dedupKeyV2,
    severity: z.enum(SIGNAL_SEVERITIES),
    polarity: z.enum(POLARITIES),
    message: z.string(),
    instrument: gid.nullable(),
    account: gid.nullable(),
    payload: jsonObject,
    run: gid.nullable(),
    firstSeenOn: calendarDate,
    firstSeenAt: timestamp.optional(),
  }),
  "signal.refreshed": payload({
    severity: z.enum(SIGNAL_SEVERITIES).optional(),
    message: z.string().optional(),
    payload: jsonObject.optional(),
    run: gid.nullable(),
    seenAt: timestamp,
  }),
  "signal.escalated": payload({
    severity: z.enum(SIGNAL_SEVERITIES),
    message: z.string(),
    payload: jsonObject,
    reactivate: z.boolean(),
    run: gid.nullable(),
    seenAt: timestamp,
  }),
  "signal.closed": payload({
    status: z.enum(SIGNAL_CLOSE_STATUSES),
    // Rule outcomes (LEADER) use the reconciler's reason text; owner-caused closes use OWNER_CLOSE_REASONS.
    reason: nonEmpty,
  }),
  "signal.reopened": payload({ reason: z.literal("alert_restored") }),
  "signal.snoozed": payload({ until: timestamp.nullable() }),
  "signal.woken": empty,

  "ruleRun.finished": payload({
    trigger: z.enum(RULE_RUN_TRIGGERS),
    asOf: calendarDate,
    status: z.enum(RULE_RUN_STATUSES),
    strategyVersion: gid.nullable(),
    stats: jsonObject,
    errors: z.array(z.string()),
    report: z.looseObject({ new: z.array(gid), escalated: z.array(gid) }),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
  }),

  "alert.created": payload({
    instrument: gid.nullable(),
    scope: z.enum(ALERT_SCOPES),
    kind: z.enum(ALERT_KINDS),
    params: jsonObject,
    polarity: z.enum(POLARITIES),
    severity: z.enum(SIGNAL_SEVERITIES),
    title: nonEmpty,
    note: z.string().nullable(),
    source: z.enum(ALERT_SOURCES),
    createdBy: z.enum(ALERT_CREATORS),
    cooldownDays: z.int().min(0).nullable(),
    expiresAt: timestamp.nullable(),
  }),
  "alert.updated": patchOf({
    title: nonEmpty,
    note: z.string().nullable(),
    params: jsonObject,
    polarity: z.enum(POLARITIES),
    severity: z.enum(SIGNAL_SEVERITIES),
    cooldownDays: z.int().min(0).nullable(),
    expiresAt: timestamp.nullable(),
  }),
  "alert.statusSet": payload({
    status: z.enum(ALERT_OWNER_STATUSES),
    snoozedUntil: timestamp.nullable(),
  }).refine((v) => (v.status === "snoozed") === (v.snoozedUntil !== null), {
    message: "snoozedUntil is set exactly when status is snoozed",
  }),
  "alert.deleted": empty,
  "alert.restored": empty,
  "alert.evaluated": payload({
    triggered: z.boolean(),
    lastCheckedAt: timestamp.optional(),
    lastValue: z.string().optional(),
    lastTriggeredAt: timestamp.optional(),
  }),
} as const;
