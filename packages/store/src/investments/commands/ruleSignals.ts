/** One strategy signal pass inside the caller's existing command context and vault write queue. */
import type { DateTime } from "@cashu/domain";
import {
  type AccountId,
  asAccountId,
  asInstrumentId,
  type InstrumentId,
  parseSignalSeverity,
  parseSignalStatus,
} from "@cashu/domain/investments";
import {
  DEFAULT_DATA_QUALITY,
  type OpenSignal,
  type RuleContext,
  type RuleOutcome,
  type RuleSpec,
  RulesEngine,
  reconcileSignals,
  type SignalReconciliation,
} from "@cashu/domain/investments/rules";
import {
  type StrategyConfig,
  type StrategyStatus,
  usableConfig,
} from "@cashu/domain/investments/strategy";
import { ZodError } from "zod";
import { type CommandContext, type CommandResult, ok, refuse } from "../../command.js";
import { accountByMemberGid } from "../../core/queries.js";
import { dedupKeyV2 } from "../../events/v1/signals.js";
import { instrumentGid, storedTime } from "../queries/shared.js";
import { closedSignals, openSignals, type SignalView } from "../queries/signals.js";
import { InvalidSignalPayloadError, signalReconciliationInput } from "./signalReconciliation.js";
import { type AppliedSignals, applySignalActions } from "./signals.js";

export interface SignalIdentities {
  /** Resolve a held identity; undefined means the vault has no such entity. */
  instrument(memberGid: string): InstrumentId | undefined;
  account(memberGid: string): AccountId | undefined;
}

export interface RuleSignalPass {
  readonly strategy: StrategyStatus;
  readonly run: string | null;
  readonly at: DateTime;
  /** Construct from canonical identities during this pass, never from a precomputed context. */
  readonly buildContext: (
    read: CommandContext["read"],
    identities: SignalIdentities,
    config: StrategyConfig,
  ) => RuleContext;
}

export interface AppliedRuleSignals {
  readonly outcomes: readonly RuleOutcome[];
  readonly reconciliation: SignalReconciliation<string>;
  readonly applied: AppliedSignals;
}

function strategySignal(key: string): boolean {
  return !["alert:", "research:", "plan:"].some((prefix) => key.startsWith(prefix));
}

function lifecycleSignal(signal: SignalView): OpenSignal<string> {
  return {
    signalId: signal.gid,
    ruleId: signal.ruleId,
    dedupKey: signal.dedupKey,
    severity: parseSignalSeverity(signal.severity),
    status: parseSignalStatus(signal.status),
    lastSeenAt: storedTime(signal.lastSeenAt),
  };
}

/** Keyed skips/not-fired scopes must use the same canonical identity as fired candidates. */
function canonicalKey(key: string, identities: SignalIdentities): boolean {
  if (!dedupKeyV2.safeParse(key).success) return false;
  return key.split("|").every((part) => {
    if (part.startsWith("i:")) return identities.instrument(part.slice(2)) === part.slice(2);
    if (part.startsWith("a:")) return identities.account(part.slice(2)) === part.slice(2);
    return true;
  });
}

/**
 * S22c supplies context/cache loading and scheduling. This helper owns no writer, clock or queue:
 * it reads, evaluates, reconciles and delegates validated writes through the SAME context.
 */
export function applyRuleSignals(
  ctx: CommandContext,
  input: RuleSignalPass,
): CommandResult<AppliedRuleSignals> {
  if (!ctx.lease.isHolder()) return refuse("not_leader");
  const identities: SignalIdentities = {
    instrument(member) {
      const root = instrumentGid(ctx.read, member);
      return root === undefined ? undefined : asInstrumentId(root);
    },
    account(member) {
      const root = accountByMemberGid(ctx.read, member)?.gid;
      return root === undefined ? undefined : asAccountId(root);
    },
  };
  const config = usableConfig(input.strategy);
  const open = openSignals(ctx.read).filter((signal) => strategySignal(signal.dedupKey));
  let outcomes: readonly RuleOutcome[] = [];
  const rules: Pick<RuleSpec, "id" | "cooldownDays">[] = [];
  if (config === null) {
    for (const id of new Set(open.map((signal) => signal.ruleId)))
      rules.push({ id, cooldownDays: null });
  } else {
    rules.push(...config.rules);
    const known = new Set(config.rules.map((rule) => rule.id));
    for (const inactive of input.strategy.result?.inactiveRules ?? []) {
      if (inactive.ruleId && !known.has(inactive.ruleId)) {
        rules.push({ id: inactive.ruleId, cooldownDays: null });
        known.add(inactive.ruleId);
      }
    }
    const context = input.buildContext(ctx.read, identities, config);
    if (context.profileId !== ctx.vault || context.portfolio.snapshot.profileId !== ctx.vault) {
      return refuse("invalid_identity");
    }
    outcomes = new RulesEngine(config.rules).evaluate(context);
    for (const outcome of outcomes) {
      if (outcome.dedupKey !== null && !canonicalKey(outcome.dedupKey, identities))
        return refuse("invalid_identity");
      if (outcome.type === "fired") {
        const candidate = outcome.candidate;
        if (
          (candidate.instrumentId !== null &&
            identities.instrument(candidate.instrumentId) !== candidate.instrumentId) ||
          (candidate.accountId !== null &&
            identities.account(candidate.accountId) !== candidate.accountId)
        )
          return refuse("invalid_identity");
      }
    }
  }
  const reconciliation = reconcileSignals({
    openSignals: open.map(lifecycleSignal),
    outcomes,
    rules,
    clock: () => input.at,
    closedSignals: closedSignals(ctx.read, { skipClosedBy: true }).map((signal) => ({
      dedupKey: signal.dedupKey,
      resolvedAt: storedTime(signal.resolvedAt),
    })),
    maxUnverifiedDays: (config?.data ?? DEFAULT_DATA_QUALITY).maxUnverifiedDays,
  });
  let dto: ReturnType<typeof signalReconciliationInput>;
  try {
    dto = signalReconciliationInput(reconciliation, {
      run: input.run,
      notify: config === null ? [] : [...config.notifications.immediate],
    });
  } catch (error) {
    if (error instanceof InvalidSignalPayloadError || error instanceof ZodError)
      return refuse("invalid_input");
    throw error;
  }
  const applied = applySignalActions.run(ctx, dto);
  return applied.ok ? ok({ outcomes, reconciliation, applied: applied.value }) : applied;
}
