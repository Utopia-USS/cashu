/** Deterministic leader alert pass over injected local market data; no fetches or scheduling. */
import { type DateTime, toStorage, utcIso } from "@cashu/domain";
import {
  alerts as domain,
  parseSignalSeverity,
  parseSignalStatus,
} from "@cashu/domain/investments";
import {
  DEFAULT_DATA_QUALITY,
  decimalText,
  NotFired,
  type RuleOutcome,
  type RuleSpec,
  reconcileSignals,
  type SignalPolarity,
  Skipped,
} from "@cashu/domain/investments/rules";
import { DEFAULT_NOTIFICATIONS, type StrategyConfig } from "@cashu/domain/investments/strategy";
import { type CommandContext, ok, refuse } from "../../command.js";
import { alertMutation } from "../queries/alertMutation.js";
import { alerts } from "../queries/alerts.js";
import { loadInstrument } from "../queries/instruments.js";
import { storedTime } from "../queries/shared.js";
import { closedSignals, openSignals } from "../queries/signals.js";
import { alertRuleId, closeAlertSignal } from "./alerts.js";
import { signalReconciliationInput } from "./signalReconciliation.js";
import { applySignalActions } from "./signals.js";

export interface AlertPassInput {
  readonly pendingWoken?: ReadonlySet<string>;
  readonly data: domain.AlertData;
  readonly now: DateTime;
  readonly config: StrategyConfig | null;
  readonly run: string | null;
}

export function applyAlertChecks(ctx: CommandContext, input: AlertPassInput) {
  if (!ctx.lease.isHolder()) return refuse("not_leader");
  if (
    input.data.ctx &&
    (input.data.ctx.profileId !== ctx.vault ||
      input.data.ctx.portfolio.snapshot.profileId !== ctx.vault)
  )
    return refuse("invalid_identity");
  const at = utcIso(input.now).replace(/\+00:00$/, "Z");
  const rows = alerts(ctx.read, input.now);
  const expiredKeys = new Set<string>();
  const wokenAlerts = new Set<string>();
  let expired = 0;
  let woken = 0;
  for (const row of rows) {
    const mutation = alertMutation(ctx.read, row.gid);
    if (row.status === "expired") {
      if (closeAlertSignal(ctx, row.gid, "alert_expired", at) !== undefined) expired += 1;
      expiredKeys.add(alertRuleId(row.gid));
    } else if (
      mutation?.ownerStatus === "snoozed" &&
      mutation.snoozedUntil !== null &&
      mutation.snoozedUntil <= toStorage(input.now)
    ) {
      ctx.emit("alert.statusSet", row.gid, {
        status: "active",
        snoozedUntil: null,
        stamps: { updated_at: at },
      });
      woken += 1;
      wokenAlerts.add(row.gid);
    }
  }
  const selected = rows.filter((row) => row.status === "active" || row.status === "triggered");
  const outcomes: RuleOutcome[] = [];
  const checks = new Map<string, domain.AlertCheck>();
  const rules: Pick<RuleSpec, "id" | "cooldownDays">[] = [];
  for (const row of selected) {
    const key = alertRuleId(row.gid);
    let check: domain.AlertCheck;
    try {
      const valid = domain.validateAlert(row.kind, row.params, {
        scope: row.scope,
        hasInstrument: row.instrument !== null,
      });
      check = domain.evaluateAlert(
        {
          id: row.gid,
          kind: valid.kind,
          scope: valid.scope,
          params: valid.params,
          title: row.title,
          severity: parseSignalSeverity(row.severity),
          polarity: row.polarity as SignalPolarity,
          instrument:
            row.instrument === null ? null : (loadInstrument(ctx.read, row.instrument) ?? null),
        },
        input.data,
      );
    } catch {
      check = { outcome: new Skipped(key, "Alert evaluation failed", key), value: null };
    }
    checks.set(row.gid, check);
    outcomes.push(check.outcome);
    rules.push({ id: key, cooldownDays: row.cooldownDays });
  }
  const reconciliation = reconcileSignals({
    openSignals: openSignals(ctx.read)
      .filter((signal) => signal.dedupKey.startsWith("alert:") && !expiredKeys.has(signal.dedupKey))
      .map((signal) => ({
        signalId: signal.gid,
        ruleId: signal.ruleId,
        dedupKey: signal.dedupKey,
        severity: parseSignalSeverity(signal.severity),
        status: parseSignalStatus(input.pendingWoken?.has(signal.gid) ? "active" : signal.status),
        lastSeenAt: storedTime(signal.lastSeenAt),
      })),
    outcomes,
    rules,
    clock: () => input.now,
    closedSignals: closedSignals(ctx.read, { skipClosedBy: true })
      .filter((signal) => signal.dedupKey.startsWith("alert:"))
      .map((signal) => ({ dedupKey: signal.dedupKey, resolvedAt: storedTime(signal.resolvedAt) })),
    maxUnverifiedDays: (input.config?.data ?? DEFAULT_DATA_QUALITY).maxUnverifiedDays,
  });
  const applied = applySignalActions.run(
    ctx,
    signalReconciliationInput(reconciliation, {
      run: input.run,
      notify: [...(input.config?.notifications ?? DEFAULT_NOTIFICATIONS).immediate],
    }),
  );
  if (!applied.ok) return applied;
  const fired = new Set(
    reconciliation.actions.flatMap((action) =>
      action.type === "create" || action.type === "refresh" || action.type === "escalate"
        ? [action.candidate.ruleId]
        : [],
    ),
  );
  const created = new Set(reconciliation.created.map((action) => action.candidate.ruleId));
  const cleared = new Set([
    ...reconciliation.resolved.map((action) => action.ruleId),
    ...reconciliation.expired
      .filter((action) => action.reason === "unverified")
      .map((action) => action.ruleId),
  ]);
  for (const row of selected) {
    const check = checks.get(row.gid);
    if (check === undefined) continue;
    const key = alertRuleId(row.gid);
    // Reads still see the pre-batch runtime register. A wake arms the alert even if an older
    // evaluation left triggered=true beneath its snoozed owner state; Skipped must keep it armed.
    const previous = wokenAlerts.has(row.gid)
      ? false
      : (alertMutation(ctx.read, row.gid)?.triggered ?? false);
    const triggered = fired.has(key)
      ? true
      : cleared.has(key) || check.outcome instanceof NotFired || check.outcome.type === "fired"
        ? false
        : previous;
    ctx.emit("alert.evaluated", row.gid, {
      triggered,
      ...(check.outcome.type === "skipped"
        ? {}
        : {
            lastCheckedAt: at,
            ...(check.value === null ? {} : { lastValue: decimalText(check.value) }),
          }),
      ...(created.has(key) ? { lastTriggeredAt: at } : {}),
    });
  }
  // No alerts_expired transition counter: the accepted clock-free registers cannot latch expiry.
  return ok({
    outcomes,
    reconciliation,
    applied: applied.value,
    housekeeping: { expiredOpenSignals: expired, wokenAlerts: woken },
    stats: {
      alerts: selected.length,
      alerts_woken: woken,
      alerts_fired: outcomes.filter((outcome) => outcome.type === "fired").length,
      alerts_skipped: outcomes.filter((outcome) => outcome.type === "skipped").length,
      alert_signals_new: reconciliation.created.length,
      alert_signals_resolved: reconciliation.resolved.length,
      alert_signals_expired: reconciliation.expired.length,
      alert_signals_suppressed: reconciliation.suppressed.length,
      alert_notifications: applied.value.notify.length,
    },
  });
}
