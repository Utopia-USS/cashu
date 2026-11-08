// Signals, rule runs and alerts payloads (events.md 8.7).
import { z } from "zod";
import { empty, patchOf, payload } from "./helpers.js";
import {
  calendarDate,
  floatPaths,
  gid,
  jsonObject,
  key,
  nonEmpty,
  timestamp,
} from "./primitives.js";

export const SIGNAL_SEVERITIES = ["info", "action"] as const;
export const POLARITIES = ["positive", "negative", "neutral"] as const;
export const SIGNAL_CLOSE_STATUSES = ["resolved", "expired"] as const;
/**
 * Close reasons any device may emit: owner actions on an alert (Python payload.closed_by) and the
 * dismissal of a research note (payload.closed_reason). Every other reason (rule outcomes,
 * `alert_expired` from housekeeping, `notes_expired`) comes from the lease holder.
 */
export const OWNER_CLOSE_REASONS = ["snooze", "mute", "delete", "note_dismissed"] as const;
export const REOPEN_REASONS = ["alert_restored", "note_restored"] as const;
/** Known rule-run triggers (informational, open set: `app` is service/autorun.py's TRIGGER). */
export const KNOWN_RULE_RUN_TRIGGERS = ["worker", "api", "cli", "app"] as const;
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
/** Known alert creators (informational, open set). */
export const KNOWN_ALERT_CREATORS = ["app", "cli", "mcp"] as const;
/** Python `alerts.catalog.MAX_TAG_LENGTH` (characters, i.e. code points). */
export const MAX_ALERT_TAG_LENGTH = 24;

/**
 * An alert's label, exactly the form Python `validate_tag` stores (Alembic 0027): lowercase, single
 * inner spaces, no edge spaces, only letters (any script, Python `str.isalpha`), ASCII digits, spaces
 * and hyphens, 1..MAX_ALERT_TAG_LENGTH characters (code points). Null = no label.
 */
const ALERT_TAG_RE = /^[\p{L}0-9-]+( [\p{L}0-9-]+)*$/u;
const alertTag = z
  .string()
  .refine(
    (t) => ALERT_TAG_RE.test(t) && t === t.toLowerCase() && [...t].length <= MAX_ALERT_TAG_LENGTH,
    {
      message: `an alert tag is Python's normalized form: lowercase letters, digits, single spaces and hyphens, at most ${MAX_ALERT_TAG_LENGTH} characters`,
    },
  );

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

/**
 * Optional fields of `signal.refreshed` / `signal.escalated` (S25-F1): a refresh may rewrite the
 * episode's rule, kind, polarity, instrument and account; absent = keep.
 *
 * Added with `.extend` after `stamps`: the log copy stores catalog payloads positionally in schema
 * key order (engine/compact.ts), so a v1 shape may only grow at its end (catalog.test.ts pins it).
 */
const refreshFields = {
  ruleId: ruleId.optional(),
  kind: nonEmpty.optional(),
  polarity: z.enum(POLARITIES).optional(),
  instrument: gid.nullable().optional(),
  account: gid.nullable().optional(),
};

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
    /** Paths of the numbers `payload` holds as decimal text (events.md 4.3, `eventBlob`). */
    payloadFloats: floatPaths.optional(),
    run: gid.nullable(),
  }),
  "signal.refreshed": payload({
    severity: z.enum(SIGNAL_SEVERITIES).optional(),
    message: z.string().optional(),
    payload: jsonObject.optional(),
    payloadFloats: floatPaths.optional(),
    run: gid.nullable(),
    seenAt: timestamp,
  }).extend(refreshFields),
  "signal.escalated": payload({
    severity: z.enum(SIGNAL_SEVERITIES),
    message: z.string(),
    payload: jsonObject,
    payloadFloats: floatPaths.optional(),
    reactivate: z.boolean(),
    run: gid.nullable(),
    seenAt: timestamp,
  }).extend(refreshFields),
  "signal.closed": payload({
    status: z.enum(SIGNAL_CLOSE_STATUSES),
    // Rule outcomes (LEADER) use the reconciler's reason text; owner-caused closes use OWNER_CLOSE_REASONS.
    reason: nonEmpty,
  }).extend({
    /** Present (null included) sets the episode's `last_run_id`; absent keeps it (S25-F2). */
    run: gid.nullable().optional(),
    /** Keys merged (shallow) into the episode payload: `closed_by`, `closed_reason`, ... (S25-F3). */
    payloadSet: jsonObject.optional(),
  }),
  "signal.reopened": payload({ reason: z.enum(REOPEN_REASONS) }).extend({
    /** Payload keys removed by the reopen (S25-F3). */
    payloadUnset: z.array(z.string()).optional(),
  }),
  "signal.snoozed": payload({ until: timestamp.nullable() }),
  /** GUARD (M7): applies only while the folded snoozedUntil still equals `until`. */
  "signal.woken": payload({ until: timestamp }),

  "ruleRun.finished": payload({
    trigger: key,
    asOf: calendarDate,
    status: z.enum(RULE_RUN_STATUSES),
    strategyVersion: gid.nullable(),
    stats: jsonObject,
    statsFloats: floatPaths.optional(),
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
    paramsFloats: floatPaths.optional(),
    polarity: z.enum(POLARITIES),
    severity: z.enum(SIGNAL_SEVERITIES),
    title: nonEmpty,
    note: z.string().nullable(),
    source: z.enum(ALERT_SOURCES),
    createdBy: key,
    cooldownDays: z.int().min(0).nullable(),
    expiresAt: timestamp.nullable(),
  }).extend({
    /** The alert's label (Alembic 0027, S31c); absent = none (a v1 create before tags). */
    tag: alertTag.nullable().optional(),
  }),
  "alert.updated": patchOf({
    title: nonEmpty,
    note: z.string().nullable(),
    params: jsonObject,
    /** Sent with `params` when it holds decimal text for numbers (events.md 4.3). */
    paramsFloats: floatPaths,
    polarity: z.enum(POLARITIES),
    severity: z.enum(SIGNAL_SEVERITIES),
    cooldownDays: z.int().min(0).nullable(),
    expiresAt: timestamp.nullable(),
    /** Set (null = clear) the label (S31c); absent = keep, like every patch field. */
    tag: alertTag.nullable(),
  }),
  "alert.statusSet": payload({
    status: z.enum(ALERT_OWNER_STATUSES),
    snoozedUntil: timestamp.nullable(),
  }).refine((v) => (v.status === "snoozed") === (v.snoozedUntil !== null), {
    message: "snoozedUntil is set exactly when status is snoozed",
  }),
  "alert.deleted": empty,
  /** `rearm: true` also clears the triggered register (S25-F6: Python re-arms a restored alert). */
  "alert.restored": empty.extend({ rearm: z.literal(true).optional() }),
  "alert.evaluated": payload({
    triggered: z.boolean(),
    lastCheckedAt: timestamp.optional(),
    lastValue: z.string().optional(),
    lastTriggeredAt: timestamp.optional(),
  }),
} as const;
