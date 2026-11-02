/** Portfolio overview: all allocation facts stay present; owner filtering affects documented KPIs/rail. */
import type { IsoDate } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import {
  allWarnings,
  instrumentLabel,
  portfolioRealizedPnlBase,
  warningMessage,
} from "../domain/index.js";
import type { StrategyStatus } from "../strategy/index.js";
import { accountsView } from "./accounts.js";
import { allocationView } from "./allocation.js";
import { attentionView, hiddenFromOwner } from "./attention.js";
import { ratioPct, viewTimestamp } from "./positions.js";
import { strategyBrief } from "./strategyStatus.js";
import type { PortfolioProjectionInput, ViewRuleRun } from "./types.js";
export interface OverviewInput extends PortfolioProjectionInput {
  readonly strategyStatus: StrategyStatus;
  readonly newestRateDate: IsoDate | null;
  readonly newestBarDate: IsoDate | null;
}
export function runView(run: ViewRuleRun | null) {
  return run === null
    ? null
    : {
        id: run.id,
        trigger: run.trigger,
        as_of: run.asOf,
        status: run.status,
        started_at: viewTimestamp(run.startedAt),
        finished_at: viewTimestamp(run.finishedAt),
        errors: run.errors,
        stats: run.stats,
        new_signal_ids: run.newSignalIds,
        escalated_signal_ids: run.escalatedSignalIds,
      };
}
export function overviewView(input: OverviewInput) {
  const { state, facts, options } = input,
    valued = state.valued,
    total = valued.totalBase,
    allocation = allocationView(input),
    open = facts.signals.filter((s) => !options.forOwner || !hiddenFromOwner(s));
  let holdings = ZERO,
    value = ZERO,
    cost = ZERO;
  for (const v of valued.valued) {
    if (v.marketValueBase !== null) holdings = holdings.add(v.marketValueBase);
    if (v.marketValueBase !== null && v.costBasisBase !== null) {
      value = value.add(v.marketValueBase);
      cost = cost.add(v.costBasisBase);
    }
  }
  const buckets = allocation.buckets.filter((b) => !options.forOwner || b.generic),
    outOfBand = buckets.filter((b) => b.out_of_band === true),
    maximum = buckets.reduce<(typeof buckets)[number] | null>(
      (best, b) => (best === null || Math.abs(b.drift_pp) > Math.abs(best.drift_pp) ? b : best),
      null,
    );
  const polarity = { positive: 0, negative: 0, neutral: 0 };
  for (const s of open) polarity[s.polarity]++;
  const alertCounts = { active: 0, triggered: 0, snoozed: 0, muted: 0, expired: 0, agent_live: 0 };
  for (const a of facts.alerts) {
    alertCounts[a.status]++;
    if (a.source === "agent" && ["active", "triggered", "snoozed"].includes(a.status))
      alertCounts.agent_live++;
  }
  const stale = valued.valued
    .filter((v) => v.isStale)
    .map((v) => ({
      instrument_id: v.instrument.id,
      label: instrumentLabel(v.instrument),
      price_date: v.priceDate,
      account_id: v.holding.accountId,
    }));
  return {
    as_of: state.asOf,
    base_currency: state.base,
    accounts_filter: state.accountFilter,
    kpis: {
      value: { total, holdings, cash: valued.cashBase },
      unrealized: {
        amount: cost.isZero() ? null : value.sub(cost),
        pct: cost.isZero() ? null : ratioPct(value.sub(cost).div(cost).toFloat()),
        cost: cost.isZero() ? null : cost,
      },
      cash: {
        amount: valued.cashBase,
        weight: total.isZero() ? null : ratioPct(valued.cashBase.div(total).toFloat()),
        accounts: new Set(
          valued.cash.filter((c) => !c.cash.amount.isZero()).map((c) => c.cash.accountId),
        ).size,
      },
      signals: {
        action: open.filter((s) => s.severity === "action").length,
        info: open.filter((s) => s.severity === "info").length,
        new: open.filter((s) => s.status === "active").length,
      },
      polarity,
      alerts: alertCounts,
      max_drift:
        maximum === null
          ? null
          : {
              bucket_id: maximum.bucket_id,
              drift_pp: maximum.drift_pp,
              out_of_band: maximum.out_of_band,
            },
      out_of_band: outOfBand.length,
      last_run: runView(facts.lastRun),
      realized: portfolioRealizedPnlBase(valued),
    },
    allocation,
    freshness: {
      prices: {
        newest_bar: input.newestBarDate,
        stale,
        stale_count: stale.length,
        stale_weight: ratioPct(valued.staleWeight),
      },
      fx: { newest_rate: input.newestRateDate, missing: [...valued.missingFxCurrencies].sort() },
      strategy: strategyBrief(input.strategyStatus),
    },
    warnings: allWarnings(valued).map((w) => ({
      kind: w.kind,
      message: warningMessage(w),
      account_id: "accountId" in w ? w.accountId : null,
      instrument_id: "instrumentId" in w ? w.instrumentId : null,
    })),
    accounts: accountsView(state.accounts, state),
    ...attentionView(input),
  };
}
export type OverviewView = ReturnType<typeof overviewView>;
