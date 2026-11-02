/** Home attention ordering and counts; this filter never changes shared annotation collections. */
import { alertMessage } from "../alerts/index.js";
import { instrumentLabel } from "../domain/index.js";
import { planInstant } from "../plan/freshness.js";
import { isPlanKey } from "../plan/keys.js";
import { isResearchKey } from "../research/index.js";
import { driftBucketGeneric } from "../rules/index.js";
import { viewTimestamp } from "./positions.js";
import type { PortfolioProjectionInput, ViewSignal } from "./types.js";
export const ATTENTION_LIMIT = 6;
export function hiddenFromOwner(signal: Pick<ViewSignal, "kind" | "payload">): boolean {
  return signal.kind === "allocation_drift" && !driftBucketGeneric(signal.payload);
}
export function signalSource(
  signal: Pick<ViewSignal, "ruleId">,
): "alert" | "plan" | "research" | "rule" {
  return signal.ruleId.startsWith("alert:")
    ? "alert"
    : isPlanKey(signal.ruleId)
      ? "plan"
      : isResearchKey(signal.ruleId)
        ? "research"
        : "rule";
}
export function polarityRank(value: string): number {
  return value === "negative" ? 0 : value === "positive" ? 1 : value === "neutral" ? 2 : 9;
}
export function attentionView(input: PortfolioProjectionInput & { readonly limit?: number }) {
  const { state, facts, options } = input,
    now = planInstant(facts.clock.now),
    held = new Set(state.valued.valued.map((v) => v.instrument.id));
  const all = facts.signals.filter((s) => !options.forOwner || !hiddenFromOwner(s)),
    snoozed = (s: ViewSignal) => s.snoozedUntil !== null && planInstant(s.snoozedUntil) > now;
  const open = all.filter((s) => !snoozed(s)),
    order = new Map(facts.signals.map((s, index) => [s.id, index]));
  const priority = (s: ViewSignal) => [
    s.status === "active" ? 0 : 1,
    s.severity === "action" ? 0 : s.severity === "info" ? 1 : 9,
    polarityRank(s.polarity),
    s.instrumentId === null || held.has(s.instrumentId) ? 0 : 1,
  ];
  const ranked = [...open].sort((a, b) => {
    const x = priority(a),
      y = priority(b);
    for (let i = 0; i < x.length; i++) {
      const delta = (x[i] ?? 0) - (y[i] ?? 0);
      if (delta) return delta;
    }
    const at = planInstant(a.lastSeenAt),
      bt = planInstant(b.lastSeenAt);
    return at !== bt ? (at > bt ? -1 : 1) : (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0);
  });
  return {
    attention: ranked.slice(0, input.limit ?? ATTENTION_LIMIT).map((s) => {
      const alertId = s.ruleId.startsWith("alert:") ? s.ruleId.slice(6) : null,
        alert = alertId === null ? undefined : facts.alerts.find((a) => a.id === alertId),
        inst = s.instrumentId === null ? undefined : state.instruments.get(s.instrumentId),
        label = inst === undefined ? null : instrumentLabel(inst),
        [code, params] = alertMessage(s.kind, s.payload, s.message, label);
      const note =
        isResearchKey(s.ruleId) && typeof s.payload.note_id === "string" ? s.payload.note_id : null;
      return {
        type: alertId === null ? "signal" : "alert",
        signal_id: s.id,
        alert_id: alertId,
        kind: s.kind,
        rule_id: s.ruleId,
        polarity: s.polarity,
        severity: s.severity,
        status: s.status,
        title: alert?.title ?? s.ruleId,
        message: s.message,
        message_code: code,
        message_params: params,
        source: alert?.source ?? signalSource(s),
        note_id: note,
        instrument_id: s.instrumentId,
        instrument_label: label,
        held: s.instrumentId !== null && held.has(s.instrumentId),
        first_seen_at: viewTimestamp(s.firstSeenAt),
        last_seen_at: viewTimestamp(s.lastSeenAt),
        current:
          facts.lastGoodRunId === null || s.lastRun === null || s.lastRun === facts.lastGoodRunId,
      };
    }),
    attention_total: open.length,
    attention_snoozed: all.filter(snoozed).length,
  };
}
export type AttentionView = ReturnType<typeof attentionView>;
