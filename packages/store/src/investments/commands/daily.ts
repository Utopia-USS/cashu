/** One vault evaluation, one command context and one append. No network runs here. */
import { parseDateTime, roundFloat } from "@cashu/domain";
import { allWarnings, asInstrumentId, asProfileId } from "@cashu/domain/investments";
import { buildRuleContext } from "@cashu/domain/investments/rules";
import { DEFAULT_NOTIFICATIONS, issueText } from "@cashu/domain/investments/strategy";
import { z } from "zod";
import { type CommandContext, defineCommand, ok, refuse } from "../../command.js";
import { calendarDate, eventBlob } from "../../events/v1/primitives.js";
import type { MarketInput } from "../marketInput.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { planFacts } from "../queries/planFacts.js";
import { openSignals, signalByGid } from "../queries/signals.js";
import { researchHousekeeping } from "../research/commands.js";
import type { StrategyState } from "../services/strategy.js";
import { portfolioAt } from "../views/portfolio.js";
import { byCreation } from "../views/stableOrder.js";
import { applyAlertChecks } from "./alertEvaluation.js";
import { stageDerivedSignals } from "./derivedSignals.js";
import { applyPlanChecks, type PlanPassInput } from "./planSignals.js";
import { applyRuleSignals } from "./ruleSignals.js";
import { type AppliedSignals, wakeSnoozedSignals } from "./signals.js";

export interface DailyEvaluation {
  readonly strategy: StrategyState;
  readonly market: MarketInput;
  readonly lang: "pl" | "en";
  readonly marketErrors?: readonly string[];
  readonly watchedPriceErrors?: readonly string[];
  /** Include sent/claimed entries: Python dedupe is per episode and queued severity. */
  readonly notificationKnown?: (signal: string, severity: string) => boolean;
  /** The optional pass can be injected for deterministic failure tests. */
  readonly planPass?: typeof applyPlanChecks;
}
export interface DailyEvaluationResult {
  readonly run: string;
  readonly status: "ok" | "partial";
  readonly stats: Readonly<Record<string, unknown>>;
  readonly errors: readonly string[];
  readonly created: readonly string[];
  readonly escalated: readonly string[];
  readonly newSignals: readonly DailySignalSummary[];
  readonly escalatedSignals: readonly DailySignalSummary[];
  readonly notify: readonly string[];
  readonly notificationIntents: readonly {
    readonly signal: string;
    readonly severity: string;
    readonly createdAt: string;
  }[];
}
export interface DailySignalSummary {
  readonly gid: string;
  readonly ruleId: string;
  readonly severity: string;
  readonly polarity: string;
  readonly message: string;
}

export function dailyEvaluation(deps: DailyEvaluation) {
  return defineCommand({
    id: "investments.dailyEvaluation",
    input: z.object({
      asOf: calendarDate,
      trigger: z.string().min(1),
      /** Opaque identity of the prepared market/strategy/claim snapshot for durable replay. */
      preparedId: z.string().optional(),
    }),
    run(ctx, input) {
      if (!ctx.lease.isHolder()) return refuse("not_leader");
      const startedAt = ctx.now();
      const now = parseDateTime(startedAt);
      const run = ctx.newGid();
      const pendingSeverity = new Map<string, string>();
      const pendingSummary = new Map<string, DailySignalSummary>();
      const parent = ctx;
      ctx = {
        ...parent,
        emit(type, target, data, options) {
          const eid = parent.emit(type, target, data, options);
          if (
            (type === "signal.opened" ||
              type === "signal.refreshed" ||
              type === "signal.escalated") &&
            typeof data.severity === "string"
          )
            pendingSeverity.set(target, data.severity);
          if (
            (type === "signal.opened" ||
              type === "signal.refreshed" ||
              type === "signal.escalated") &&
            typeof data.severity === "string" &&
            typeof data.ruleId === "string" &&
            typeof data.polarity === "string" &&
            typeof data.message === "string"
          )
            pendingSummary.set(target, {
              gid: target,
              ruleId: data.ruleId,
              severity: data.severity,
              polarity: data.polarity,
              message: data.message,
            });
          return eid;
        },
      };
      const notificationIntents: { signal: string; severity: string; createdAt: string }[] = [];
      const remembered = new Set<string>();
      const remember = (ids: readonly string[]) => {
        let added = 0;
        for (const signal of ids) {
          const severity = pendingSeverity.get(signal) ?? signalByGid(ctx.read, signal)?.severity;
          const key = JSON.stringify([signal, severity]);
          if (
            severity !== undefined &&
            !remembered.has(key) &&
            !deps.notificationKnown?.(signal, severity)
          ) {
            notificationIntents.push({ signal, severity, createdAt: ctx.now() });
            remembered.add(key);
            added++;
          }
        }
        return added;
      };
      const loaded = portfolioAt(ctx.read, {
        vault: asProfileId(ctx.vault),
        asOf: input.asOf,
        strategy: deps.strategy,
        lang: deps.lang,
        ...deps.market,
        instrumentIds: [...vaultInstrumentGids(ctx.read)].map(asInstrumentId),
      });
      if (!loaded.ok) return loaded;
      const state = loaded.value;
      const config = deps.strategy.config;
      const context = buildRuleContext({
        profileId: asProfileId(ctx.vault),
        asOf: input.asOf,
        portfolio: state.valued,
        market: state.market,
        allocation: state.allocation,
        data: config?.data,
        contributions: config?.contributions,
        lang: deps.lang,
      });
      const errors = [...(deps.marketErrors ?? [])];
      const firstIssue = deps.strategy.issues.find((i) => i.severity === "error");
      if (deps.strategy.state === "invalid")
        errors.push(
          `strategy invalid, rules not run: ${deps.strategy.readError ?? (firstIssue ? issueText(firstIssue) : "invalid")}`,
        );
      for (const inactive of deps.strategy.inactiveRules)
        errors.push(
          `rule ${inactive.ruleId || inactive.index} inactive: ${inactive.issues[0]?.message ?? "invalid"}`,
        );
      const wake = wakeSnoozedSignals.run(ctx, {
        notify: [...(config?.notifications ?? DEFAULT_NOTIFICATIONS).immediate],
      });
      if (!wake.ok) return wake;
      remember(wake.value.notify);
      const pendingWoken = new Set(wake.value.woken);
      const rules = applyRuleSignals(ctx, {
        strategy: { ...deps.strategy, latest: deps.strategy.version },
        at: now,
        run,
        buildContext: () => context,
        pendingWoken,
      });
      if (!rules.ok) return rules;
      const ruleNotifications = remember(rules.value.applied.notify);
      const alerts = applyAlertChecks(ctx, {
        now,
        run,
        config,
        pendingWoken,
        data: {
          asOf: input.asOf,
          bars: state.historyBars,
          ctx: context,
          maxPriceAgeDays: context.data.maxPriceAgeDays,
          lang: deps.lang,
        },
      });
      if (!alerts.ok) return alerts;
      const alertNotifications = remember(alerts.value.applied.notify);
      let planNotifications = 0;
      let planChecked = 0;
      let planError = "derived_failed";
      const plans = stageDerivedSignals(ctx, (child: CommandContext) => {
        try {
          const facts = planFacts(child.read, { valued: state.valued, now });
          planChecked = facts.length;
          const pass: PlanPassInput = {
            facts,
            now,
            run,
            config,
            lang: deps.lang,
            pendingWoken,
          };
          return (deps.planPass ?? applyPlanChecks)(child, pass);
        } catch (error) {
          planError =
            error instanceof Error ? `${error.name}: ${error.message}` : "unknown failure";
          throw error;
        }
      });
      // A lease loss is an authority failure, never a recoverable plan failure.
      if (!ctx.lease.isHolder()) return refuse("not_leader");
      if (!plans.ok && plans.reason === "not_leader") return plans;
      if (!plans.ok) errors.push(`plan checks failed: ${planError}`);
      else {
        plans.flush();
        planNotifications = remember(plans.value.applied.notify);
      }
      const research = researchHousekeeping.run(ctx, { lang: deps.lang });
      if (!research.ok) return research;
      const passes: AppliedSignals[] = [rules.value.applied, alerts.value.applied];
      if (plans.ok) passes.push(plans.value.applied);
      const unique = (values: readonly string[]) => [...new Set(values)];
      const created = unique(passes.flatMap((p) => p.created));
      const escalated = unique(passes.flatMap((p) => p.escalated));
      const summaries = (ids: readonly string[]) =>
        ids.flatMap((gid) => {
          const draft = pendingSummary.get(gid);
          if (draft) return [draft];
          const row = signalByGid(ctx.read, gid);
          return row
            ? [
                {
                  gid: row.gid,
                  ruleId: row.ruleId,
                  severity: row.severity,
                  polarity: row.polarity,
                  message: row.message,
                },
              ]
            : [];
        });
      const newSignals = summaries(created);
      const escalatedSignals = byCreation(ctx.read, "signals", summaries(escalated));
      const notify = unique(notificationIntents.map((i) => i.signal));
      const stats = {
        strategy: deps.strategy.state,
        strategy_version: deps.strategy.version?.version ?? null,
        holdings: state.valued.valued.length,
        accounts: state.accounts.length,
        base_currency: state.base,
        total_base: state.valued.totalBase.toString(),
        stale_weight: roundFloat(state.valued.staleWeight, 6),
        warnings: allWarnings(state.valued).length,
        missing_fx: [...state.valued.missingFxCurrencies].sort(),
        signals_woken: wake.value.woken.length,
        rules: config?.rules.length ?? 0,
        ...(config === null
          ? {}
          : {
              inactive_rules: deps.strategy.inactiveRules.length,
              fired: rules.value.outcomes.filter((o) => o.type === "fired").length,
              not_fired: rules.value.outcomes.filter((o) => o.type === "not_fired").length,
              skipped: rules.value.outcomes.filter((o) => o.type === "skipped").length,
            }),
        ...(config !== null ||
        openSignals(ctx.read).some(
          (s) => !["alert:", "research:", "plan:"].some((prefix) => s.dedupKey.startsWith(prefix)),
        )
          ? rules.value.reconciliation.stats
          : {}),
        ...alerts.value.stats,
        alert_notifications: alertNotifications,
        ...(plans.ok
          ? {
              plan_checked: planChecked,
              plan_fired: plans.value.outcomes.filter((o) => o.type === "fired").length,
              plan_skipped: plans.value.outcomes.filter((o) => o.type === "skipped").length,
              plan_signals_new: plans.value.applied.created.length,
              plan_signals_resolved: plans.value.applied.resolved.length,
              plan_notifications: planNotifications,
            }
          : {}),
        ...research.value,
        notifications: ruleNotifications + alertNotifications + planNotifications,
        watched_price_errors: deps.watchedPriceErrors ?? [],
      };
      const status = errors.length ? "partial" : "ok";
      if (!ctx.lease.isHolder()) return refuse("not_leader");
      ctx.emit("ruleRun.finished", run, {
        trigger: input.trigger,
        asOf: input.asOf,
        status,
        strategyVersion: deps.strategy.version?.gid ?? null,
        ...eventBlob("stats", stats), // stale_weight 0.25 travels as "0.25" (events.md 4.3)
        errors,
        report: { new: created, escalated },
        startedAt,
        finishedAt: ctx.now(),
      });
      return ok<DailyEvaluationResult>({
        run,
        status,
        stats,
        errors,
        created,
        escalated,
        newSignals,
        escalatedSignals,
        notify,
        notificationIntents,
      });
    },
  });
}
