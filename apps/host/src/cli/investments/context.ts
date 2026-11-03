import { parseDateTime } from "@cashu/domain";
import { performance as perf } from "@cashu/domain/investments";
import { enabledModuleIds, mcpProfile } from "@cashu/store/core";
import type { PerformanceService } from "@cashu/store/investments/performance";
import type { InvestmentScreenSources } from "@cashu/store/investments/screen";
import type { StrategyState } from "@cashu/store/investments/services";
import type { MarketInput } from "@cashu/store/investments/views";
import type { HostStores, OpenVault } from "../../stores.js";
import { localDate } from "../budget/context.js";
import { supportsConsoleUnicode } from "../core/console.js";
import type { CommandIo } from "../tree.js";

export interface InvestmentCliDeps {
  readonly stores: Pick<HostStores, "vaults">;
  readonly now: () => number;
  readonly sources: InvestmentScreenSources;
  readonly performance: PerformanceService;
}

export interface InvestmentContext {
  readonly vault: OpenVault;
  readonly slug: string;
  readonly asOf: string;
  readonly now: ReturnType<typeof parseDateTime>;
  readonly timeZone: string;
  readonly strategy: StrategyState;
  readonly market: MarketInput;
}

/** Refuse ambiguous slugs and unbound/currently invalid file or market authorities. */
export function investmentContext(
  io: CommandIo,
  root: { readonly profile?: string },
  deps: InvestmentCliDeps,
): InvestmentContext | null {
  const slug = root.profile || io.env.CASHU_PROFILE;
  if (!slug || !supportsConsoleUnicode(io)) return null;
  const matches = [...deps.stores.vaults.values()].filter(
    (vault) => mcpProfile(vault.store.read.bind(vault.store))?.slug === slug,
  );
  if (matches.length !== 1) return null;
  const vault = matches[0];
  if (!vault || !enabledModuleIds(vault.store.read.bind(vault.store)).has("investments"))
    return null;
  const read = vault.store.read.bind(vault.store);
  const strategy = deps.sources.strategy?.current(read);
  if (strategy?.status !== "current" || strategy.vault !== vault.id) return null;
  const market = deps.sources.market?.current(read);
  if (!market) return null;
  const clock = deps.sources.clock?.current();
  const now = clock?.now ?? parseDateTime(new Date(deps.now()).toISOString());
  const timeZone = clock?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    vault,
    slug,
    asOf: localDate(deps.now()),
    now,
    timeZone,
    strategy: strategy.state,
    market,
  };
}

export function performanceStrategy(context: InvestmentContext): perf.PerformanceStrategy {
  const config = context.strategy.config;
  return {
    state: context.strategy.state,
    benchmark: config?.benchmark ?? null,
    policy:
      config === null
        ? perf.DEFAULT_VALUATION_POLICY
        : {
            maxPriceAgeDays: config.data.maxPriceAgeDays,
            maxFxAgeDays: config.data.maxFxAgeDays,
          },
    strategy:
      config === null ? null : { baseCurrency: config.baseCurrency, allocation: config.allocation },
  };
}
