/** Live Portfolio screen projections. Every SQL input uses the tracked read supplied by the query. */

import { parseDateTime } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { builtinRegistry } from "@cashu/domain/core";
import {
  asAccountId,
  asInstrumentId,
  asProfileId,
  performance as perf,
  views,
} from "@cashu/domain/investments";
import { enabledModuleIds } from "../../core/queries.js";
import { defineQuery, type Read } from "../../query.js";
import { brokerIds } from "../commands/accounts.js";
import { performanceInputs } from "../performance/inputs.js";
import { alerts } from "../queries/alerts.js";
import { loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { brokerageAccounts, transactions } from "../queries/transactions.js";
import { readAccounts } from "../views/accounts.js";
import { readOverview } from "../views/overview.js";
import { canonicalAccountFilter, type PortfolioViewRequest } from "../views/portfolio.js";
import {
  readAllocation,
  readPositionChart,
  readPositionDetail,
  readPositions,
} from "../views/positions.js";
import { readWatchlist } from "../views/watchlist.js";
import {
  type CurrentStrategySource,
  combinedChanges,
  type InvestmentMarketSource,
  type InvestmentScreenClock,
  investmentInstrumentDto,
  investmentPositionDto,
} from "./sources.js";

export type PortfolioArgs = {
  readonly today: string;
  readonly now?: string;
  readonly timeZone?: string;
  readonly lang: UiLang;
  readonly account?: string | null;
  readonly range?: string;
};
export type AssetArgs = PortfolioArgs & {
  readonly instrument: string | null;
  readonly months?: number;
};

export interface InvestmentScreenSources {
  readonly strategy?: CurrentStrategySource;
  readonly market?: InvestmentMarketSource;
  readonly importAvailable?: (read: Read) => boolean;
  readonly clock?: InvestmentScreenClock;
}

function requestFor(read: Read, args: PortfolioArgs, sources: InvestmentScreenSources) {
  if (!enabledModuleIds(read).has("investments"))
    return { status: "unavailable" as const, reason: "module_disabled" };
  const clock = sources.clock?.current();
  const now = clock?.now ?? (args.now === undefined ? undefined : parseDateTime(args.now));
  const timeZone = args.timeZone ?? clock?.timeZone;
  if (now === undefined || timeZone === undefined)
    return { status: "unavailable" as const, reason: "clock_unavailable" };
  const strategy = sources.strategy?.current(read);
  if (strategy === undefined || strategy.status !== "current")
    return {
      status: "unavailable" as const,
      reason: strategy?.reason ?? "current_files_unavailable",
    };
  const market = sources.market?.current(read);
  if (market == null) return { status: "unavailable" as const, reason: "market_unavailable" };
  const accounts = canonicalAccountFilter(
    read,
    args.account == null ? null : [asAccountId(args.account)],
  );
  if (!accounts.ok) return { status: "refused" as const, reason: accounts.reason };
  const request: PortfolioViewRequest = {
    ...market,
    vault: asProfileId(strategy.vault),
    asOf: args.today,
    clock: {
      today: args.today,
      now,
      timeZone,
    },
    strategy: strategy.state,
    lang: args.lang,
    forOwner: true,
    accounts: accounts.accounts,
  };
  return { status: "ready" as const, request, revision: strategy.revision };
}

export function investmentDesktopQueries(sources: InvestmentScreenSources = {}) {
  const changes = combinedChanges(
    ...[
      ...(sources.strategy ? [sources.strategy.changes] : []),
      ...(sources.market ? [sources.market.changes] : []),
    ],
  );
  return {
    metadata: defineQuery({
      id: "investments.desktop.metadata",
      run(read, args: { readonly lang: UiLang }) {
        const registry = builtinRegistry().institutions;
        return {
          brokers: brokerIds().map((id) => ({ id, name: registry.displayName(id, args.lang) })),
          importAvailable:
            enabledModuleIds(read).has("investments") && (sources.importAvailable?.(read) ?? false),
          instruments: enabledModuleIds(read).has("investments")
            ? [...loadInstruments(read, vaultInstrumentGids(read)).values()].map((instrument) => ({
                id: instrument.id,
                label: instrument.name || instrument.symbol || instrument.id,
                currency: instrument.currency,
              }))
            : [],
        };
      },
    }),
    portfolio: defineQuery({
      id: "investments.desktop.portfolio",
      changes,
      run(read, args: PortfolioArgs) {
        const accounts = brokerageAccounts(read);
        const context = requestFor(read, args, sources);
        if (context.status !== "ready") return { ...context, accounts };
        const { request } = context;
        const range = args.range ?? "1y";
        if (!perf.isRangeKey(range))
          return { status: "refused" as const, reason: "unknown_range", accounts };
        const positions = readPositions(read, request);
        const allocation = readAllocation(read, request);
        const overview = readOverview(read, {
          ...request,
          newestRateDate: sources.market?.newestRateDate() ?? null,
        });
        const accountViews = readAccounts(read, request);
        const watch = readWatchlist(read, request);
        if (!positions.ok || !allocation.ok || !overview.ok || !accountViews.ok || !watch.ok)
          return { status: "refused" as const, reason: "invalid_context", accounts };
        const config = request.strategy.config;
        const strategy: perf.PerformanceStrategy = {
          state: request.strategy.state,
          benchmark: config?.benchmark ?? null,
          policy:
            config === null
              ? perf.DEFAULT_VALUATION_POLICY
              : {
                  maxPriceAgeDays: config.data.maxPriceAgeDays,
                  maxFxAgeDays: config.data.maxFxAgeDays,
                },
          strategy:
            config === null
              ? null
              : { baseCurrency: config.baseCurrency, allocation: config.allocation },
        };
        const computed = perf.computePerformance(
          performanceInputs(read, { ...request, strategy }),
          args.today,
        );
        return {
          status: "ready" as const,
          accounts,
          revision: context.revision,
          positions: {
            ...positions.value,
            positions: positions.value.positions.map(investmentPositionDto),
          },
          allocation: allocation.value,
          overview: overview.value,
          accountViews: accountViews.value,
          watch: watch.value.map((row) => ({
            ...row,
            instrument: row.instrument === null ? null : investmentInstrumentDto(row.instrument),
          })),
          performance: perf.performanceView(computed, range, request.accounts ?? null),
          contributions: views.monthlyContributions(
            perf.performanceView(computed, "max", request.accounts ?? null).points,
            args.today,
          ),
          contributionPlan: config?.contributions ?? null,
          strategy: {
            state: request.strategy.state,
            issues: request.strategy.issues,
            inactiveRules: request.strategy.inactiveRules,
            readError: request.strategy.readError,
          },
        };
      },
    }),
    asset: defineQuery({
      id: "investments.desktop.asset",
      changes,
      run(read, args: AssetArgs) {
        if (args.instrument === null) return { status: "none" as const };
        const context = requestFor(read, args, sources);
        if (context.status !== "ready") return context;
        const request = {
          ...context.request,
          instrument: asInstrumentId(args.instrument),
          historyDays: null,
          ...(args.months === undefined ? {} : { months: args.months }),
        };
        const detail = readPositionDetail(read, request);
        const chart = readPositionChart(read, request);
        if (!detail.ok || !chart.ok)
          return { status: "refused" as const, reason: "unknown_instrument" };
        const priceAlerts = alerts(read, context.request.clock.now)
          .filter(
            (row) =>
              row.instrument === detail.value.instrument.id &&
              ["active", "triggered", "snoozed"].includes(row.status) &&
              ["price_above", "price_below"].includes(row.kind),
          )
          .flatMap((row) =>
            typeof row.params.level === "number"
              ? [
                  {
                    id: row.gid,
                    status: row.status,
                    kind: row.kind,
                    source: row.source,
                    level: row.params.level,
                  },
                ]
              : [],
          );
        return {
          status: "ready" as const,
          detail: {
            ...detail.value,
            instrument: investmentInstrumentDto(detail.value.instrument),
            position:
              detail.value.position === null ? null : investmentPositionDto(detail.value.position),
          },
          chart: chart.value,
          priceAlerts,
          quoteFacts: views.assetQuoteFacts(
            chart.value,
            detail.value.position?.price ?? null,
            priceAlerts,
          ),
          lotFacts: views.assetLotFacts(detail.value.position?.lots ?? []),
          fees: views.assetFeeSummary(detail.value.transactions),
        };
      },
    }),
    ledger: defineQuery({
      id: "investments.desktop.ledger",
      run(read, args: { readonly instrument?: string | null; readonly account?: string | null }) {
        if (!enabledModuleIds(read).has("investments"))
          return { ok: false as const, reason: "module_disabled" };
        const accounts = canonicalAccountFilter(
          read,
          args.account == null ? null : [asAccountId(args.account)],
        );
        if (!accounts.ok) return accounts;
        return {
          ok: true as const,
          rows: transactions(read).filter(
            (row) =>
              (args.instrument == null || row.instrumentId === args.instrument) &&
              (accounts.accounts === null || accounts.accounts.includes(row.accountId)),
          ),
        };
      },
    }),
  };
}

export type PortfolioSnapshot = ReturnType<
  ReturnType<typeof investmentDesktopQueries>["portfolio"]["run"]
>;
export type AssetSnapshot = ReturnType<ReturnType<typeof investmentDesktopQueries>["asset"]["run"]>;
export {
  addUiManualTransaction,
  classifyUiInstrument,
  createUiBrokerageAccount,
  uiThesisCommands,
  updateUiWatchNote,
} from "./commands.js";
export * from "./import.js";
