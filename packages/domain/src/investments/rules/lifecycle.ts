/** One run's pure signal reconciliation (Python rules/lifecycle.py); persistence is the caller's. */
import { type DateTime, PyValueError } from "../../dates.js";
import { type SignalSeverity, SignalStatus, severityRank } from "../domain/enums.js";
import type { RuleSpec } from "./config.js";
import { dayMicros, elapsedMicros, plusDays } from "./lifecycleTime.js";
import type { RuleOutcome, SignalCandidate } from "./outcomes.js";

export interface OpenSignal<Id = string> {
  readonly signalId: Id;
  readonly ruleId: string;
  readonly dedupKey: string;
  readonly severity: SignalSeverity;
  readonly status?: SignalStatus;
  readonly lastSeenAt?: DateTime | null;
}
export interface ClosedSignal {
  readonly dedupKey: string;
  readonly resolvedAt: DateTime;
}
export interface CreateSignal {
  readonly type: "create";
  readonly candidate: SignalCandidate;
  readonly createdAt: DateTime;
}
export interface RefreshSignal<Id = string> {
  readonly type: "refresh";
  readonly signalId: Id;
  readonly candidate: SignalCandidate;
  readonly seenAt: DateTime;
}
export interface EscalateSignal<Id = string> {
  readonly type: "escalate";
  readonly signalId: Id;
  readonly candidate: SignalCandidate;
  readonly previousSeverity: SignalSeverity;
  readonly reactivate: boolean;
  readonly seenAt: DateTime;
}
export interface ResolveSignal<Id = string> {
  readonly type: "resolve";
  readonly signalId: Id;
  readonly ruleId: string;
  readonly dedupKey: string;
  readonly resolvedAt: DateTime;
}
export interface ExpireSignal<Id = string> {
  readonly type: "expire";
  readonly signalId: Id;
  readonly ruleId: string;
  readonly dedupKey: string;
  readonly expiredAt: DateTime;
  readonly reason: string | null;
}
export interface SuppressCandidate {
  readonly type: "suppress";
  readonly candidate: SignalCandidate;
  readonly cooldownUntil: DateTime;
}
export type SignalAction<Id = string> =
  | CreateSignal
  | RefreshSignal<Id>
  | EscalateSignal<Id>
  | ResolveSignal<Id>
  | ExpireSignal<Id>
  | SuppressCandidate;

export const UNVERIFIED = "unverified";

export class SignalReconciliation<Id = string> {
  readonly actions: readonly SignalAction<Id>[];
  readonly untouched: readonly OpenSignal<Id>[];
  constructor(
    actions: readonly SignalAction<Id>[] = [],
    untouched: readonly OpenSignal<Id>[] = [],
  ) {
    this.actions = [...actions];
    this.untouched = [...untouched];
  }
  get created(): readonly CreateSignal[] {
    return this.actions.filter((a): a is CreateSignal => a.type === "create");
  }
  get refreshed(): readonly RefreshSignal<Id>[] {
    return this.actions.filter((a): a is RefreshSignal<Id> => a.type === "refresh");
  }
  get escalated(): readonly EscalateSignal<Id>[] {
    return this.actions.filter((a): a is EscalateSignal<Id> => a.type === "escalate");
  }
  get resolved(): readonly ResolveSignal<Id>[] {
    return this.actions.filter((a): a is ResolveSignal<Id> => a.type === "resolve");
  }
  get expired(): readonly ExpireSignal<Id>[] {
    return this.actions.filter((a): a is ExpireSignal<Id> => a.type === "expire");
  }
  get suppressed(): readonly SuppressCandidate[] {
    return this.actions.filter((a): a is SuppressCandidate => a.type === "suppress");
  }
  get stats(): Readonly<Record<string, number>> {
    return {
      signals_new: this.created.length,
      signals_escalated: this.escalated.length,
      signals_refreshed: this.refreshed.length,
      signals_resolved: this.resolved.length,
      signals_expired: this.expired.length,
      signals_suppressed: this.suppressed.length,
    };
  }
}

export interface ReconcileSignalsInput<Id = string> {
  readonly openSignals: Iterable<OpenSignal<Id>>;
  readonly outcomes: Iterable<RuleOutcome>;
  readonly rules: readonly Pick<RuleSpec, "id" | "cooldownDays">[];
  readonly clock: () => DateTime;
  readonly closedSignals?: Iterable<ClosedSignal>;
  readonly maxUnverifiedDays?: number | null;
}

export function reconcileSignals<Id = string>(
  input: ReconcileSignalsInput<Id>,
): SignalReconciliation<Id> {
  const now = input.clock();
  const open = [...input.openSignals];
  const byKey = new Map<string, OpenSignal<Id>>();
  for (const signal of open) {
    if (byKey.has(signal.dedupKey)) throw new PyValueError("Two open signals share the dedup key");
    byKey.set(signal.dedupKey, signal);
  }
  const closed = new Map<string, DateTime>();
  for (const signal of input.closedSignals ?? []) {
    const previous = closed.get(signal.dedupKey);
    if (previous === undefined || elapsedMicros(signal.resolvedAt, previous) > 0n)
      closed.set(signal.dedupKey, signal.resolvedAt);
  }
  const cooldowns = new Map(input.rules.map((rule) => [rule.id, rule.cooldownDays]));
  const fired = new Map<string, SignalCandidate>();
  const evaluated = new Set<string>();
  const skippedRules = new Set<string>();
  const skippedKeys = new Set<string>();
  for (const outcome of input.outcomes) {
    evaluated.add(outcome.ruleId);
    if (outcome.type === "fired") {
      const candidate = outcome.candidate;
      const current = fired.get(candidate.dedupKey);
      if (
        current === undefined ||
        severityRank(candidate.severity) > severityRank(current.severity)
      )
        fired.set(candidate.dedupKey, candidate);
    } else if (outcome.type === "skipped") {
      if (outcome.dedupKey === null) skippedRules.add(outcome.ruleId);
      else skippedKeys.add(outcome.dedupKey);
    }
  }
  const actions: SignalAction<Id>[] = [];
  for (const candidate of fired.values()) {
    const existing = byKey.get(candidate.dedupKey);
    if (existing !== undefined) {
      if (severityRank(candidate.severity) > severityRank(existing.severity)) {
        actions.push({
          type: "escalate",
          signalId: existing.signalId,
          candidate,
          previousSeverity: existing.severity,
          reactivate: existing.status === SignalStatus.ACKNOWLEDGED,
          seenAt: now,
        });
      } else actions.push({ type: "refresh", signalId: existing.signalId, candidate, seenAt: now });
      continue;
    }
    const days = cooldowns.get(candidate.ruleId);
    const at = closed.get(candidate.dedupKey);
    if (days && at !== undefined) {
      const until = plusDays(at, days);
      if (elapsedMicros(now, until) < 0n) {
        actions.push({ type: "suppress", candidate, cooldownUntil: until });
        continue;
      }
    }
    actions.push({ type: "create", candidate, createdAt: now });
  }
  const untouched: OpenSignal<Id>[] = [];
  for (const signal of open) {
    if (fired.has(signal.dedupKey)) continue;
    if (!cooldowns.has(signal.ruleId)) {
      actions.push({
        type: "expire",
        signalId: signal.signalId,
        ruleId: signal.ruleId,
        dedupKey: signal.dedupKey,
        expiredAt: now,
        reason: null,
      });
    } else if (
      !evaluated.has(signal.ruleId) ||
      skippedRules.has(signal.ruleId) ||
      skippedKeys.has(signal.dedupKey)
    ) {
      const limit = input.maxUnverifiedDays;
      const seen =
        signal.lastSeenAt == null
          ? null
          : signal.lastSeenAt.offsetSeconds === null && now.offsetSeconds !== null
            ? { ...signal.lastSeenAt, offsetSeconds: now.offsetSeconds }
            : signal.lastSeenAt;
      if (limit != null && seen !== null && elapsedMicros(now, seen) > dayMicros(limit)) {
        actions.push({
          type: "expire",
          signalId: signal.signalId,
          ruleId: signal.ruleId,
          dedupKey: signal.dedupKey,
          expiredAt: now,
          reason: UNVERIFIED,
        });
      } else untouched.push(signal);
    } else
      actions.push({
        type: "resolve",
        signalId: signal.signalId,
        ruleId: signal.ruleId,
        dedupKey: signal.dedupKey,
        resolvedAt: now,
      });
  }
  return new SignalReconciliation(actions, untouched);
}
