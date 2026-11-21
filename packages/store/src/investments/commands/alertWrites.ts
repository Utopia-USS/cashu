/** Validated owner alert transitions. Evaluation and expiry housekeeping are separate leader passes. */
import {
  addMicroseconds,
  type DateTime,
  PyValueError,
  parseDateTime,
  toStorage,
  utcIso,
} from "@cashu/domain";
import * as domain from "@cashu/domain/investments/alerts";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { eventBlob, gid, timestamp } from "../../events/v1/primitives.js";
import type { Read } from "../../query.js";
import { type AlertMutation, alertMutation } from "../queries/alertMutation.js";
import { alertByGid, LIVE_ALERT_STATUSES, liveAgentAlerts } from "../queries/alerts.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { instrumentGid, storedTime } from "../queries/shared.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import { closeAlertSignal, reopenAlertSignal } from "./alerts.js";

const DAY = 86_400_000_000;
const eventTime = (value: DateTime) => utcIso(value).replace(/\+00:00$/, "Z");
const future = (value: unknown, days: unknown, now: DateTime): string | null => {
  if (days !== undefined && days !== null) {
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650)
      throw new TypeError("invalid expiry days");
    return eventTime(addMicroseconds(now, days * DAY));
  }
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new TypeError("invalid expiry");
  const at = parseDateTime(value);
  if (at.offsetSeconds === null || toStorage(at) <= toStorage(now))
    throw new TypeError("expiry is not future");
  const result = eventTime(at);
  if (!timestamp.safeParse(result).success) throw new TypeError("invalid expiry");
  return result;
};
const cooldown = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650)
    throw new TypeError("invalid cooldown");
  return value;
};
function choice(value: unknown, fallback: string, choices: readonly string[]): string {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string" || !choices.includes(value)) throw new TypeError("invalid choice");
  return value;
}
type KnownBuckets = ReadonlySet<string> | ((read: Read) => ReadonlySet<string> | null);
function validBuckets(
  ctx: CommandContext,
  refs: readonly string[],
  known?: KnownBuckets,
): true | "unknown_bucket" | "current_files_unavailable" {
  if (!refs.length) return true;
  if (known !== undefined) {
    const current = typeof known === "function" ? known(ctx.read) : known;
    if (current === null) return "current_files_unavailable";
    return refs.every((ref) => current.has(ref)) ? true : "unknown_bucket";
  }
  const stored = latestStrategyVersion(ctx.read);
  if (stored === undefined) return "unknown_bucket";
  const result = loadStrategy(stored.yamlText, stored.mdText);
  const config = result.config ?? result.partial;
  const storedKnown = new Set(config?.allocation.buckets.map((bucket) => bucket.id) ?? []);
  return refs.every((ref) => storedKnown.has(ref)) ? true : "unknown_bucket";
}
const createInput = z.strictObject({
  kind: z.string(),
  title: z.unknown(),
  params: z.unknown().default({}),
  instrument: gid.nullable().default(null),
  scope: z.unknown().optional(),
  polarity: z.unknown().optional(),
  severity: z.unknown().optional(),
  note: z.unknown().optional(),
  tag: z.unknown().optional(),
  cooldownDays: z.unknown().optional(),
  expiresAt: z.unknown().optional(),
  expiresInDays: z.unknown().optional(),
  source: z.enum(["user", "agent"]).default("user"),
  createdBy: z.string().min(1).default("app"),
});

export function createAlertWithBuckets(known?: KnownBuckets) {
  const buckets = known === undefined || typeof known === "function" ? known : new Set(known);
  return defineCommand({
    id: "investments.createAlert",
    input: createInput,
    run(ctx, input) {
      const now = parseDateTime(ctx.now());
      try {
        const valid = domain.validateAlert(input.kind, input.params, {
          scope: input.scope,
          hasInstrument: input.instrument !== null,
        });
        const [title, note] = domain.validateText(input.title, input.note ?? null);
        const tag = domain.validateTag(input.tag ?? null);
        const instrument =
          input.instrument === null ? null : instrumentGid(ctx.read, input.instrument);
        if (
          instrument === undefined ||
          (instrument !== null && !vaultInstrumentGids(ctx.read).has(instrument))
        )
          return refuse("no_instrument");
        const bucketCheck = validBuckets(ctx, valid.bucketRefs, buckets);
        if (bucketCheck !== true) return refuse(bucketCheck);
        if (input.source === "agent" && liveAgentAlerts(ctx.read, now) >= 50)
          return refuse("agent_alert_limit");
        const payload = {
          instrument,
          kind: valid.kind,
          scope: valid.scope,
          // A threshold 0.1 travels as "0.1" (events.md 4.3); the alerts fold puts the number back.
          ...eventBlob("params", valid.params),
          title,
          note,
          tag,
          polarity: choice(input.polarity, "neutral", ["positive", "negative", "neutral"]),
          severity: choice(input.severity, "info", ["info", "action"]),
          cooldownDays: cooldown(input.cooldownDays),
          expiresAt: future(input.expiresAt, input.expiresInDays, now),
          source: input.source,
          createdBy: input.createdBy,
        };
        const alert = ctx.newGid();
        ctx.emit("alert.created", alert, {
          ...payload,
          stamps: { created_at: eventTime(now), updated_at: eventTime(now) },
        });
        return ok({ alert });
      } catch (error) {
        if (
          error instanceof domain.AlertValidationError ||
          error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof PyValueError
        )
          return refuse("alert_invalid");
        throw error;
      }
    },
  });
}
export const createAlert = createAlertWithBuckets();

const UPDATABLE = new Set([
  "title",
  "note",
  "tag",
  "params",
  "polarity",
  "severity",
  "cooldownDays",
  "expiresAt",
  "expiresInDays",
  "status",
  "snoozeDays",
  "snoozedUntil",
]);
export function updateAlertWithBuckets(known?: KnownBuckets) {
  const buckets = known === undefined || typeof known === "function" ? known : new Set(known);
  return defineCommand({
    id: "investments.updateAlert",
    input: z.strictObject({ alert: gid, changes: z.record(z.string(), z.unknown()) }),
    run(ctx, input) {
      const row = alertMutation(ctx.read, input.alert);
      if (row === undefined || row.deletedAt !== null) return refuse("no_alert");
      if (Object.keys(input.changes).some((key) => !UPDATABLE.has(key)))
        return refuse("unknown_field");
      const c = input.changes;
      const now = parseDateTime(ctx.now());
      const expired = alertByGid(ctx.read, row.gid, now)?.status === "expired";
      if (expired && ("expiresAt" in c || "expiresInDays" in c) && c.status !== "active")
        return refuse("delegate_expired_extension");
      if (expired && row.triggered && c.status === "active")
        return refuse("delegate_expired_rearm");
      try {
        const patch: Record<string, unknown> = {};
        if ("title" in c || "note" in c) {
          const [title, note] = domain.validateText(
            "title" in c ? c.title : row.title,
            "note" in c ? c.note : row.note,
          );
          patch.title = title;
          patch.note = note;
        }
        if ("tag" in c) patch.tag = domain.validateTag(c.tag);
        if ("params" in c) {
          const valid = domain.validateAlert(row.kind, c.params, {
            scope: row.scope,
            hasInstrument: row.instrument !== null,
          });
          const bucketCheck = validBuckets(ctx, valid.bucketRefs, buckets);
          if (bucketCheck !== true) return refuse(bucketCheck);
          Object.assign(patch, eventBlob("params", valid.params));
        }
        if ("polarity" in c)
          patch.polarity = choice(c.polarity, row.polarity, ["positive", "negative", "neutral"]);
        if ("severity" in c) patch.severity = choice(c.severity, row.severity, ["info", "action"]);
        if ("cooldownDays" in c) patch.cooldownDays = cooldown(c.cooldownDays);
        if (c.expiresInDays != null) patch.expiresAt = future(null, c.expiresInDays, now);
        else if ("expiresAt" in c) patch.expiresAt = future(c.expiresAt, null, now);
        let status: string | undefined;
        let until: string | null = null;
        if ("status" in c || "snoozeDays" in c || "snoozedUntil" in c) {
          status =
            c.status == null && ("snoozeDays" in c || "snoozedUntil" in c)
              ? "snoozed"
              : (c.status as string);
          if (!["active", "muted", "snoozed"].includes(status)) return refuse("alert_invalid");
          if (status === "snoozed") {
            if (
              c.snoozeDays != null &&
              (typeof c.snoozeDays !== "number" ||
                !Number.isInteger(c.snoozeDays) ||
                c.snoozeDays < 1 ||
                c.snoozeDays > 365)
            )
              return refuse("alert_invalid");
            until = future(c.snoozedUntil, c.snoozeDays, now);
            if (until === null) return refuse("alert_invalid");
          }
          if (status === "active") {
            const expires = "expiresAt" in patch ? patch.expiresAt : row.expiresAt;
            if (typeof expires === "string" && toStorage(expires) <= toStorage(now))
              return refuse("alert_expired");
          }
        }
        // Validation completes before the first emit, including the implicit updated_at bump.
        if (Object.keys(patch).length > 0 || status === undefined)
          ctx.emit("alert.updated", row.gid, {
            ...(Object.keys(patch).length ? patch : { title: row.title }),
            stamps: { updated_at: eventTime(now) },
          });
        if (status !== undefined) {
          ctx.emit("alert.statusSet", row.gid, {
            status,
            snoozedUntil: until,
            stamps: { updated_at: eventTime(now) },
          });
          if (status === "muted" || status === "snoozed")
            closeAlertSignal(ctx, row.gid, status === "muted" ? "mute" : "snooze", eventTime(now));
        }
        return ok({ alert: row.gid });
      } catch (error) {
        if (
          error instanceof domain.AlertValidationError ||
          error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof PyValueError
        )
          return refuse("alert_invalid");
        throw error;
      }
    },
  });
}
export const updateAlert = updateAlertWithBuckets();

export const deleteAlert = defineCommand({
  id: "investments.deleteAlert",
  input: z.object({ alert: gid }),
  run(ctx, input) {
    const row = alertMutation(ctx.read, input.alert);
    if (row === undefined || row.deletedAt !== null) return refuse("no_alert");
    const at = ctx.now();
    closeAlertSignal(ctx, row.gid, "delete", at);
    ctx.emit("alert.deleted", row.gid, { stamps: { deleted_at: at } });
    return ok({ alert: row.gid });
  },
});

export const restoreAlert = defineCommand({
  id: "investments.restoreAlert",
  input: z.object({ alert: gid }),
  run(ctx, input) {
    const row = alertMutation(ctx.read, input.alert);
    if (row === undefined) return refuse("no_alert");
    if (row.deletedAt === null) return ok({ alert: row.gid });
    const now = parseDateTime(ctx.now());
    if (toStorage(now) > toStorage(addMicroseconds(storedTime(row.deletedAt), 900_000_000)))
      return refuse("undo_expired");
    if (
      row.source === "agent" &&
      LIVE_ALERT_STATUSES.has(alertByStatus(row, now)) &&
      liveAgentAlerts(ctx.read, now) >= 50
    )
      return refuse("agent_alert_limit");
    const reopened = reopenAlertSignal(ctx, row.gid, eventTime(storedTime(row.deletedAt)));
    ctx.emit(
      "alert.restored",
      row.gid,
      row.triggered && reopened === undefined ? { rearm: true } : {},
    );
    return ok({ alert: row.gid });
  },
});

function alertByStatus(row: AlertMutation, now: DateTime): domain.EffectiveAlertStatus {
  const status =
    row.ownerStatus === "muted" || row.ownerStatus === "snoozed"
      ? row.ownerStatus
      : row.triggered
        ? "triggered"
        : "active";
  return domain.effectiveAlertStatus(
    { status, expires_at: row.expiresAt, snoozed_until: row.snoozedUntil },
    now,
  ).status;
}
