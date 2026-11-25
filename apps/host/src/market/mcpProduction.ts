/** Per-call native investment MCP inputs from checked strategy files and the host market cache. */
import { parseDateTime } from "@cashu/domain";
import { asProfileId, toCurrency } from "@cashu/domain/investments";
import { strategyDigest } from "@cashu/domain/investments/strategy";
import {
  type InvestmentHistoryReads,
  type InvestmentReads,
  type InvestmentWriteServices,
  investmentReads,
  investmentWriteServices,
  type NativeToolStore,
  type ResearchServices,
  researchServices,
  type ToolContext,
} from "@cashu/mcp";
import { investmentsPerformance, investmentsViews } from "@cashu/store";
import type { SqlCalendarCache, SqlPriceCache } from "@cashu/store/investments/local";
import { latestStrategyVersion } from "@cashu/store/investments/queries";
import { performanceStrategy, readResearchInputs } from "@cashu/store/investments/research-screen";
import type { MarketInput } from "@cashu/store/investments/screen-sources";
import { strategySnapshot } from "@cashu/store/investments/screen-sources";
import { strategyPublicationPorts } from "../proposals/strategyFiles.js";
import type { OpenVault } from "../stores.js";
import { cachedMacroCloses, calendarFeeds } from "./researchCache.js";

export interface NativeInvestmentMcpInput {
  readonly prices: SqlPriceCache;
  readonly calendar: SqlCalendarCache;
  readonly marketForVault: (
    read: ToolContext<NativeToolStore>["store"]["read"],
    vault: string,
  ) => MarketInput;
  readonly language: () => "pl" | "en";
  readonly vaults: ReadonlyMap<string, OpenVault>;
  readonly isCurrent: (vault: OpenVault) => boolean;
}

/** The provider is invoked inside one native MCP call, before its command is buffered. */
export function nativeInvestmentMcp(input: NativeInvestmentMcpInput) {
  const performance = new investmentsPerformance.PerformanceService();
  const prepare = (ctx: ToolContext<NativeToolStore>) => {
    const id = ctx.store.read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
    const vault = id === undefined ? undefined : input.vaults.get(id);
    if (vault?.mode !== "native" || !input.isCurrent(vault))
      throw new Error("native_investment_mcp_unavailable");
    const authority = vault.native.strategyDirectoryAuthority();
    if (authority?.vault !== vault.id || !authority.isCurrent())
      throw new Error("native_investment_strategy_unavailable");
    const files = strategyPublicationPorts(authority).files;
    const source = files.readSync();
    const digest = strategyDigest(source.yaml ?? "", source.md);
    const session = vault.native.workspaceAuthority();
    if (session?.vault !== vault.id || !session.isCurrent())
      throw new Error("native_investment_strategy_unavailable");
    const currentVersion = latestStrategyVersion(ctx.store.read) ?? null;
    const snapshot = strategySnapshot(ctx.store.read, {
      vault: vault.id,
      generation: session.generation,
      revision: `${digest}:${currentVersion?.version ?? 0}:${currentVersion?.sha256 ?? "missing"}`,
      files: { ...source, readError: null },
    });
    if (snapshot.status !== "current" || !authority.isCurrent() || !input.isCurrent(vault))
      throw new Error("native_investment_strategy_unavailable");
    const version = JSON.stringify(snapshot.state.version);
    const portfolio = {
      vault: asProfileId(vault.id),
      asOf: ctx.today,
      clock: {
        today: ctx.today,
        now: parseDateTime(new Date(ctx.store.now()).toISOString()),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      strategy: snapshot.state,
      lang: input.language(),
      ...input.marketForVault(ctx.store.read, vault.id),
      forOwner: false,
    } as const;
    const isReadable = () => {
      try {
        if (
          input.vaults.get(vault.id) !== vault ||
          !input.isCurrent(vault) ||
          !authority.isCurrent() ||
          vault.native.workspaceAuthority()?.generation !== session.generation
        )
          return false;
        const current = files.readSync();
        return (
          strategyDigest(current.yaml ?? "", current.md) === digest &&
          JSON.stringify(latestStrategyVersion(ctx.store.read) ?? null) === version
        );
      } catch {
        return false;
      }
    };
    const isHolder = (candidate: string) =>
      candidate === vault.id && isReadable() && vault.native.canFetchPublicMarket();
    return { vault, files, source, portfolio, isReadable, isHolder };
  };
  return {
    investmentReads(ctx: ToolContext<NativeToolStore>): InvestmentReads {
      const bound = prepare(ctx);
      const base = ctx.store.read<{ baseCurrency: string }>(
        "SELECT base_currency AS baseCurrency FROM profiles",
      )[0]?.baseCurrency;
      if (base === undefined) throw new Error("native_investment_profile_unavailable");
      let calendar = null;
      try {
        const feeds = calendarFeeds(input.calendar.rawBytes());
        if (feeds !== null) {
          const research = readResearchInputs(ctx.store.read, {
            ...bound.portfolio,
            macro: { status: "current", value: cachedMacroCloses(input.prices) },
            calendar: { status: "current", value: feeds },
          });
          calendar = research.calendar.status === "current" ? research.calendar.value : null;
        }
      } catch {
        // A malformed or unavailable local feed leaves the rest of the review readable.
      }
      const reads = investmentReads(ctx, {
        portfolio: { ...bound.portfolio, newestRateDate: input.prices.newestFxDate() },
        review: {
          clock: investmentsViews.makeReviewClock(bound.portfolio.clock),
          lang: bound.portfolio.lang,
          config: bound.portfolio.strategy.config,
          calendar,
        },
        strategy: {
          state: bound.portfolio.strategy,
          profileBase: toCurrency(base),
          lang: bound.portfolio.lang,
          files: {
            yaml: "strategy.yaml",
            md: "strategy.md",
            yamlExists: bound.source.yaml !== null,
            mdExists: bound.source.md !== null,
          },
        },
      });
      const requireCurrent = () => {
        if (!bound.isReadable()) throw new Error("native_investment_mcp_unavailable");
      };
      return {
        positions: () => {
          requireCurrent();
          return reads.positions();
        },
        overview: () => {
          requireCurrent();
          return reads.overview();
        },
        reviewContext: () => {
          requireCurrent();
          return reads.reviewContext();
        },
        strategyStatus: () => {
          requireCurrent();
          return reads.strategyStatus();
        },
      };
    },
    investmentHistory(ctx: ToolContext<NativeToolStore>): InvestmentHistoryReads {
      const bound = prepare(ctx);
      const requireCurrent = () => {
        if (!bound.isReadable()) throw new Error("native_investment_mcp_unavailable");
      };
      return {
        portfolio(asOf) {
          requireCurrent();
          const result = investmentsViews.portfolioAt(ctx.store.read, { ...bound.portfolio, asOf });
          if (!result.ok) throw new Error("native_investment_history_unavailable");
          return result.value;
        },
        performance() {
          requireCurrent();
          return performance.historyMetrics(bound.vault.store, {
            asOf: ctx.today,
            strategy: performanceStrategy(bound.portfolio.strategy),
            ...input.marketForVault(ctx.store.read, bound.vault.id),
          });
        },
      };
    },
    research(ctx: ToolContext<NativeToolStore>): ResearchServices {
      const bound = prepare(ctx);
      return researchServices(ctx, {
        portfolio: bound.portfolio,
        macroCloses: cachedMacroCloses(input.prices),
        isHolder: bound.isHolder,
      });
    },
    investmentWrites(ctx: ToolContext<NativeToolStore>): InvestmentWriteServices {
      const bound = prepare(ctx);
      return investmentWriteServices(ctx, {
        portfolio: bound.portfolio,
        isHolder: bound.isHolder,
        strategyFiles: {
          vault: bound.vault.id,
          isCurrent: () => bound.isHolder(bound.vault.id),
          read: () => {
            if (!bound.isHolder(bound.vault.id))
              throw new Error("native_investment_strategy_unavailable");
            return bound.files.readSync();
          },
        },
      });
    },
  };
}
