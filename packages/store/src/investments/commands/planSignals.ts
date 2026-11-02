/** Daily or one-instrument plan checks, distinct from strategy-rule ownership. */
import type { DateTime } from "@cashu/domain";
import {
  type InstrumentId,
  parseSignalSeverity,
  parseSignalStatus,
  plan,
} from "@cashu/domain/investments";
import { DEFAULT_DATA_QUALITY, NotFired, reconcileSignals } from "@cashu/domain/investments/rules";
import { DEFAULT_NOTIFICATIONS, type StrategyConfig } from "@cashu/domain/investments/strategy";
import { type CommandContext, ok, refuse } from "../../command.js";
import { instrumentGid, storedTime } from "../queries/shared.js";
import { openSignals } from "../queries/signals.js";
import { signalReconciliationInput } from "./signalReconciliation.js";
import { applySignalActions } from "./signals.js";

export interface PlanPassInput {
  readonly pendingWoken?: ReadonlySet<string>;
  readonly facts: readonly plan.PlanFacts[];
  readonly now: DateTime;
  readonly run: string | null;
  readonly config: StrategyConfig | null;
  readonly lang: "pl" | "en";
  readonly only?: InstrumentId;
}
export function applyPlanChecks(ctx: CommandContext, input: PlanPassInput) {
  if (!ctx.lease.isHolder()) return refuse("not_leader");
  if (input.only !== undefined && instrumentGid(ctx.read, input.only) !== input.only)
    return refuse("invalid_identity");
  if (
    input.facts.some(
      (fact) =>
        instrumentGid(ctx.read, fact.instrumentId) !== fact.instrumentId ||
        (input.only !== undefined && fact.instrumentId !== input.only),
    )
  )
    return refuse("invalid_identity");
  const outcomes = plan.evaluatePlanChecks(input.facts, input.lang);
  if (input.only === undefined)
    outcomes.push(...plan.CHECKS.map((check) => new NotFired(plan.planRuleId(check))));
  else if (!input.facts.length)
    outcomes.push(
      ...plan.CHECKS.map(
        (check) =>
          new NotFired(
            plan.planRuleId(check),
            plan.planDedupKey(check, input.only as InstrumentId),
          ),
      ),
    );
  const keys =
    input.only === undefined
      ? null
      : new Set(plan.CHECKS.map((check) => plan.planDedupKey(check, input.only as InstrumentId)));
  const reconciliation = reconcileSignals({
    openSignals: openSignals(ctx.read)
      .filter(
        (signal) =>
          signal.dedupKey.startsWith("plan:") && (keys === null || keys.has(signal.dedupKey)),
      )
      .map((signal) => ({
        signalId: signal.gid,
        ruleId: signal.ruleId,
        dedupKey: signal.dedupKey,
        severity: parseSignalSeverity(signal.severity),
        status: parseSignalStatus(input.pendingWoken?.has(signal.gid) ? "active" : signal.status),
        lastSeenAt: storedTime(signal.lastSeenAt),
      })),
    outcomes,
    rules: plan.planRuleSpecs(),
    clock: () => input.now,
    maxUnverifiedDays:
      input.only === undefined
        ? (input.config?.data ?? DEFAULT_DATA_QUALITY).maxUnverifiedDays
        : null,
  });
  const applied = applySignalActions.run(
    ctx,
    signalReconciliationInput(reconciliation, {
      run: input.run,
      notify: [...(input.config?.notifications ?? DEFAULT_NOTIFICATIONS).immediate],
    }),
  );
  return applied.ok ? ok({ outcomes, reconciliation, applied: applied.value }) : applied;
}
