// The alert side of signals (Python `store/alerts.py`, write side): closing an alert's open signal
// when the owner mutes, snoozes or deletes it, and reopening it on a restore. These are building
// blocks the alert commands (S22b) call inside their own batch: the alert event and its signal event
// go together (events.md 5, 6.5), so they take the command's context instead of being commands.
import type { CommandContext } from "../../command.js";
import { viewTimestamp } from "../../sql/values.js";
import type { Read } from "../queries/shared.js";
import { type SignalView, signalByGid } from "../queries/signals.js";

/** Python `CLOSED_BY_KEY`: the payload key of an alert signal an owner action or the expiry closed. */
export const CLOSED_BY_KEY = "closed_by";

/**
 * Who closes an alert's signal: the owner's mute / snooze / delete (any device) or the alert's own
 * expiry (`alert_expired`, from the lease holder's housekeeping).
 */
export type AlertCloseReason = "snooze" | "mute" | "delete" | "alert_expired";

/** Python `alert_rule_id`: rule id and dedup key of an alert's signal. */
export const alertRuleId = (alert: string) => `alert:${alert}`;

function alertSignals(read: Read, alert: string, statuses: readonly string[]): SignalView[] {
  return read<{ gid: string }>(
    `SELECT gid FROM inv_signals WHERE dedup_key = ? AND status IN (${statuses.map(() => "?").join(", ")})
     ORDER BY id DESC`,
    alertRuleId(alert),
    ...statuses,
  ).flatMap((r) => signalByGid(read, r.gid) ?? []);
}

/**
 * Python `close_open_signal`: expire the alert's open signal (muted, snoozed or deleted alerts stop
 * speaking at once), marked with `reason` under CLOSED_BY_KEY so the close never starts the alert's
 * cooldown. `at` (an event timestamp, default now) is the close time; pass the alert event's time so a
 * later restore finds this close (`reopenAlertSignal`). Returns the closed episode, or undefined.
 */
export function closeAlertSignal(
  ctx: CommandContext,
  alert: string,
  reason: AlertCloseReason,
  at: string = ctx.now(),
): SignalView | undefined {
  const open = alertSignals(ctx.read, alert, ["active", "acknowledged"])[0];
  if (open === undefined) return undefined;
  ctx.emit("signal.closed", open.gid, {
    status: "expired",
    reason,
    payloadSet: { [CLOSED_BY_KEY]: reason },
    stamps: { closed_at: at },
  });
  return open;
}

/**
 * Python `reopen_signal_closed_at`: reopen the alert's signal that `closeAlertSignal` expired at
 * `closedAt` (an event timestamp; an alert restore). The fold restores acknowledged when a live
 * decision links it, else active (events.md 8.7). Undefined when there is no such signal or another
 * signal of the alert is open.
 */
export function reopenAlertSignal(
  ctx: CommandContext,
  alert: string,
  closedAt: string,
): SignalView | undefined {
  if (alertSignals(ctx.read, alert, ["active", "acknowledged"]).length > 0) return undefined;
  const at = viewTimestamp(closedAt);
  const row = alertSignals(ctx.read, alert, ["expired"]).find((s) => s.closedAt === at);
  if (row === undefined) return undefined;
  ctx.emit("signal.reopened", row.gid, {
    reason: "alert_restored",
    payloadUnset: [CLOSED_BY_KEY],
  });
  return row;
}
