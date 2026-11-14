// Signal commands (Python `store/signals.py`, write side): applying one rule run's lifecycle actions,
// snoozing a signal and waking the snoozes that passed.
//
// Emit rules (events.md 8.7, 6.2 LEADER): rule outcomes (open, refresh, escalate, resolve, expire)
// and wake-ups come from the fetch-lease holder only, so `applySignalActions` and
// `wakeSnoozedSignals` refuse `not_leader` elsewhere; a snooze is the owner's and runs anywhere. The
// notification log is device-local (events.md 10): the commands return which signals the caller's
// device should notify, they never write it.
//
// Close payloads (S25-F3, R-S8): an age-based expiry writes `closed_reason` + `closed_by` (Python
// `store/signals.py:200-205`), so the close never starts a cooldown (`closedSignals({skipClosedBy})`);
// a resolve and a removed-rule expiry write no payload keys and set `last_run_id`.
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { eventBlob, gid, jsonObject, timestamp } from "../../events/v1/primitives.js";
import { dedupKeyV2, POLARITIES, SIGNAL_SEVERITIES } from "../../events/v1/signals.js";
import { viewTimestamp } from "../../sql/values.js";
import { eventTimeOf } from "../queries/shared.js";
import { openSignals, type SignalView, signalByGid } from "../queries/signals.js";

/** A fired rule's wish (Python `SignalCandidate`): ids are gids, the payload JSON-encodable. */
const candidate = z.object({
  ruleId: z.string().min(1),
  kind: z.string().min(1),
  dedupKey: dedupKeyV2,
  severity: z.enum(SIGNAL_SEVERITIES),
  message: z.string(),
  instrument: gid.nullable().default(null),
  account: gid.nullable().default(null),
  payload: jsonObject.default({}),
  polarity: z.enum(POLARITIES).default("neutral"),
});
type Candidate = z.infer<typeof candidate>;

/** Python `rules.lifecycle` actions (`SuppressCandidate` stores nothing, so it has no form here). */
const action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), candidate, createdAt: timestamp }),
  z.object({ type: z.literal("refresh"), signal: gid, candidate, seenAt: timestamp }),
  z.object({
    type: z.literal("escalate"),
    signal: gid,
    candidate,
    reactivate: z.boolean(),
    seenAt: timestamp,
  }),
  z.object({ type: z.literal("resolve"), signal: gid, resolvedAt: timestamp }),
  z.object({
    type: z.literal("expire"),
    signal: gid,
    expiredAt: timestamp,
    /** null for a removed rule; `unverified` (or another age reason) for an age-based close. */
    reason: z.string().min(1).nullable().default(null),
  }),
]);

/** What applying one run's actions changed (signal gids), plus the signals to notify on this device. */
export interface AppliedSignals {
  readonly created: readonly string[];
  readonly escalated: readonly string[];
  readonly refreshed: readonly string[];
  readonly resolved: readonly string[];
  readonly expired: readonly string[];
  /** New and escalated signals whose severity the policy notifies (an escalation unless snoozed). */
  readonly notify: readonly string[];
}

/** Close reasons of rule outcomes (the reconciler has no text of its own for these two). */
export const RESOLVED_REASON = "rule_cleared";
export const RULE_REMOVED_REASON = "rule_removed";

/**
 * Python `_fill`: every candidate field the episode takes over on a refresh / escalation. A payload
 * float (`weight: 0.18`) travels as decimal text (events.md 4.3); the signals fold puts it back.
 */
const fill = (c: Candidate) => ({
  severity: c.severity,
  message: c.message,
  ...eventBlob("payload", c.payload),
  ruleId: c.ruleId,
  kind: c.kind,
  polarity: c.polarity,
  instrument: c.instrument,
  account: c.account,
});

const isSnoozed = (s: SignalView, at: string) =>
  s.snoozedUntil !== null && s.snoozedUntil > viewTimestamp(at);

export const applySignalActions = defineCommand({
  id: "investments.applySignalActions",
  input: z.object({
    actions: z.array(action),
    /** The rule run the actions come from (`ruleRun.finished` of the same batch or earlier). */
    run: gid.nullable(),
    notify: z.array(z.enum(SIGNAL_SEVERITIES)).default([]),
  }),
  /**
   * Python `apply_reconciliation`, leader only. Every refresh / escalate / resolve / expire names a
   * signal open in this vault's view (the reconciliation was computed from it); a stale one refuses
   * `not_open` and nothing is written.
   */
  run(ctx, input) {
    if (!ctx.lease.isHolder()) return refuse("not_leader");
    const open = new Map(openSignals(ctx.read).map((s) => [s.gid, s]));
    const target = (g: string) => {
      const s = signalByGid(ctx.read, g);
      return s !== undefined && open.has(s.gid) ? s : undefined;
    };
    const notify = new Set(input.notify);
    const out: { [K in keyof AppliedSignals]: string[] } = {
      created: [],
      escalated: [],
      refreshed: [],
      resolved: [],
      expired: [],
      notify: [],
    };
    for (const a of input.actions) {
      if (a.type === "create") {
        const g = ctx.newGid();
        const c = a.candidate;
        ctx.emit("signal.opened", g, {
          ruleId: c.ruleId,
          kind: c.kind,
          dedupKey: c.dedupKey,
          severity: c.severity,
          polarity: c.polarity,
          message: c.message,
          instrument: c.instrument,
          account: c.account,
          ...eventBlob("payload", c.payload),
          run: input.run,
          stamps: { first_seen_at: a.createdAt, last_seen_at: a.createdAt },
        });
        out.created.push(g);
        if (notify.has(c.severity)) out.notify.push(g);
        continue;
      }
      const s = target(a.signal);
      if (s === undefined) return refuse("not_open");
      switch (a.type) {
        case "refresh":
          ctx.emit("signal.refreshed", s.gid, {
            ...fill(a.candidate),
            run: input.run,
            seenAt: a.seenAt,
          });
          out.refreshed.push(s.gid);
          break;
        case "escalate":
          ctx.emit("signal.escalated", s.gid, {
            ...fill(a.candidate),
            reactivate: a.reactivate,
            run: input.run,
            seenAt: a.seenAt,
          });
          out.escalated.push(s.gid);
          if (notify.has(a.candidate.severity) && !isSnoozed(s, a.seenAt)) out.notify.push(s.gid);
          break;
        case "resolve":
          ctx.emit("signal.closed", s.gid, {
            status: "resolved",
            reason: RESOLVED_REASON,
            run: input.run,
            stamps: { closed_at: a.resolvedAt },
          });
          out.resolved.push(s.gid);
          break;
        case "expire":
          ctx.emit("signal.closed", s.gid, {
            status: "expired",
            ...(a.reason === null
              ? { reason: RULE_REMOVED_REASON, run: input.run }
              : // An age-based close: no run confirmed it, so `last_run_id` keeps the last run that
                // did; `closed_by` keeps it out of cooldowns.
                { reason: a.reason, payloadSet: { closed_reason: a.reason, closed_by: a.reason } }),
            stamps: { closed_at: a.expiredAt },
          });
          out.expired.push(s.gid);
          break;
      }
    }
    return ok<AppliedSignals>(out);
  },
});

/** Validated persistence DTO, shared with the pure lifecycle adapter. */
export type SignalActionsInput = z.output<typeof applySignalActions.input>;

/** Python `snooze`, on the signal's episode. Shared by the commands that snooze in their own batch. */
export function snoozeSignal(ctx: CommandContext, signal: SignalView, until: string | null): void {
  ctx.emit("signal.snoozed", signal.gid, { until });
}

export const snoozeSignalCommand = defineCommand({
  id: "investments.snoozeSignal",
  input: z.object({ signal: gid, until: timestamp.nullable() }),
  /**
   * Python `snooze`: hide an open signal until `until` (null: back now). The caller's device drops
   * its own pending notifications of the signal (device-local).
   */
  run(ctx, input) {
    const s = signalByGid(ctx.read, input.signal);
    if (s === undefined || (s.status !== "active" && s.status !== "acknowledged")) {
      return refuse("not_open");
    }
    snoozeSignal(ctx, s, input.until);
    return ok({ signal: s.gid });
  },
});

export const wakeSnoozedSignals = defineCommand({
  id: "investments.wakeSnoozedSignals",
  input: z.object({ notify: z.array(z.enum(SIGNAL_SEVERITIES)).default([]) }),
  /**
   * Python `wake_snoozed`, leader only: open signals whose snooze passed come back active
   * (`signal.woken {until}`, a GUARD on the folded snooze end, M7). Returns the woken gids and those
   * the caller's device notifies.
   */
  run(ctx, input) {
    if (!ctx.lease.isHolder()) return refuse("not_leader");
    const now = viewTimestamp(ctx.now());
    const notify = new Set<string>(input.notify);
    const woken: string[] = [];
    const notified: string[] = [];
    for (const s of openSignals(ctx.read)) {
      if (s.snoozedUntil === null || s.snoozedUntil > now) continue;
      ctx.emit("signal.woken", s.gid, { until: eventTimeOf(s.snoozedUntil) });
      woken.push(s.gid);
      if (notify.has(s.severity)) notified.push(s.gid);
    }
    return ok({ woken, notify: notified });
  },
});
