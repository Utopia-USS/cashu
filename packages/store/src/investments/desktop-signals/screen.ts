/** Live owner surfaces stay readable even when valuation or current-file authority is unavailable. */
import { parseDateTime, utcIso } from "@cashu/domain";
import type { UiLang } from "@cashu/domain/core";
import { alerts as alertDomain, asProfileId } from "@cashu/domain/investments";
import { enabledModuleIds } from "../../core/queries.js";
import { defineQuery, type Read } from "../../query.js";
import {
  type CurrentStrategySource,
  combinedChanges,
  type InvestmentMarketSource,
  type InvestmentScreenClock,
  investmentInstrumentDto,
  investmentPositionDto,
} from "../desktop/sources.js";
import { alertCounts, watchlist } from "../queries/alerts.js";
import { heldSince } from "../queries/holdings.js";
import { loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import { decisionSignalGids, decisions, theses } from "../queries/journal.js";
import { lastRun } from "../queries/signals.js";
import { brokerageAccounts } from "../queries/transactions.js";
import { readOverview } from "../views/overview.js";
import type { PortfolioViewRequest } from "../views/portfolio.js";
import { readAllocation, readPositions } from "../views/positions.js";
import { readWatchlist } from "../views/watchlist.js";
import { readAlertRows } from "./alertRows.js";
import { readSignalRows } from "./reads.js";

export interface SignalsScreenSources {
  readonly strategy?: CurrentStrategySource;
  readonly market?: InvestmentMarketSource;
  readonly clock?: InvestmentScreenClock & {
    readonly changes: import("../../query.js").ChangeSource;
  };
}
export type SignalsArgs = {
  readonly now: string;
  readonly today: string;
  readonly timeZone: string;
  readonly lang: UiLang;
  readonly privacy: boolean;
};
function valuationContext(read: Read, args: SignalsArgs, sources: SignalsScreenSources) {
  const strategy = sources.strategy?.current(read);
  if (strategy === undefined || strategy.status !== "current")
    return {
      status: "unavailable" as const,
      reason: strategy?.reason ?? "current_files_unavailable",
    };
  const market = sources.market?.current(read);
  if (market == null) return { status: "unavailable" as const, reason: "market_unavailable" };
  const request: PortfolioViewRequest = {
    ...market,
    vault: asProfileId(strategy.vault),
    asOf: args.today,
    strategy: strategy.state,
    clock: { today: args.today, now: parseDateTime(args.now), timeZone: args.timeZone },
    lang: args.lang,
    forOwner: true,
    accounts: null,
  };
  const positions = readPositions(read, request),
    allocation = readAllocation(read, request);
  const overview = readOverview(read, {
    ...request,
    newestRateDate: sources.market?.newestRateDate() ?? null,
  });
  const watched = readWatchlist(read, request);
  if (!positions.ok || !allocation.ok || !overview.ok || !watched.ok)
    return { status: "unavailable" as const, reason: "invalid_context" };
  return {
    status: "ready" as const,
    revision: strategy.revision,
    positions: {
      ...positions.value,
      positions: positions.value.positions.map(investmentPositionDto),
    },
    allocation: allocation.value,
    overview: overview.value,
    watchlist: watched.value.map((row) => ({
      ...row,
      instrument: row.instrument === null ? null : investmentInstrumentDto(row.instrument),
    })),
    contributionDay: strategy.state.config?.contributions?.dayOfMonth ?? null,
  };
}
export function signalsQueries(sources: SignalsScreenSources = {}) {
  return {
    screen: defineQuery({
      id: "investments.signals.screen",
      changes: combinedChanges(
        ...[
          ...(sources.strategy ? [sources.strategy.changes] : []),
          ...(sources.market ? [sources.market.changes] : []),
          ...(sources.clock ? [sources.clock.changes] : []),
        ],
      ),
      run(read, args: SignalsArgs) {
        if (args.privacy) return { status: "unavailable" as const, reason: "privacy" };
        if (!enabledModuleIds(read).has("investments"))
          return { status: "unavailable" as const, reason: "module_disabled" };
        const instant = sources.clock?.current();
        const now = instant === undefined ? args.now : utcIso(instant.now);
        const effectiveArgs = { ...args, now, timeZone: instant?.timeZone ?? args.timeZone };
        const journal = decisions(read);
        const links = decisionSignalGids(
          read,
          journal.map((row) => row.gid),
        );
        const instruments = loadInstruments(read, vaultInstrumentGids(read));
        return {
          status: "ready" as const,
          asOf: now,
          signals: readSignalRows(read, now, "all"),
          open: readSignalRows(read, now, "open"),
          alerts: readAlertRows(read, now, args.today, sources.market?.current(read) ?? null),
          counts: alertCounts(read, now),
          catalog: alertDomain.catalogDicts(),
          decisions: journal.map((row) => ({ ...row, signals: links.get(row.gid) ?? [] })),
          accounts: brokerageAccounts(read),
          instruments: [...instruments.values()],
          theses: theses(read),
          watchlist: watchlist(read),
          held: [...heldSince(read, args.today).keys()],
          lastRun: lastRun(read) ?? null,
          context: valuationContext(read, effectiveArgs, sources),
        };
      },
    }),
  };
}
export type SignalsScreenResult = ReturnType<ReturnType<typeof signalsQueries>["screen"]["run"]>;
export type ReadySignals = Extract<SignalsScreenResult, { status: "ready" }>;
