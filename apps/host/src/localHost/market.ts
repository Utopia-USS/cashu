// The leader-only production market runtime (native hosts with an injected factory) and the
// market-backed authorities the queries, CLI and MCP share: the runtime's own where it has one,
// otherwise the injected options (the MCP read / write / research authorities prefer the options).
import type { RunningHost } from "@cashu/node-host";
import type { StartRecord } from "../crashLoop.js";
import type { ProductionMarket } from "../market/production.js";
import type { HostStores } from "../stores.js";
import type { LocalHostOptions } from "./options.js";

/** Starts the market runtime; it acts for a vault only while that vault and this host are current. */
export function startMarket(input: {
  readonly options: LocalHostOptions;
  readonly nativeMode: boolean;
  readonly server: RunningHost;
  readonly stores: HostStores;
  readonly record: StartRecord;
  readonly now: () => number;
}): ProductionMarket | undefined {
  const { options, server, stores, record } = input;
  return input.nativeMode
    ? options.marketFactory?.(
        stores,
        (vault) =>
          server.lock.held &&
          !server.stopping &&
          stores.vaults.get(vault.id) === vault &&
          vault.mode === "native" &&
          vault.native.isCurrent() &&
          !record.safeMode,
        input.now,
      )
    : undefined;
}

export function marketAuthorities(
  options: LocalHostOptions,
  runtime: ProductionMarket | undefined,
) {
  return {
    prices: runtime?.prices ?? options.mcpPrices ?? options.overview?.prices ?? null,
    fxNewest: runtime?.fxNewest ?? options.mcpFxNewest,
    investmentAsync: runtime?.investmentAsync ?? options.mcpInvestmentAsync,
    research: options.mcpResearch ?? runtime?.mcpResearch,
    investmentWrites: options.mcpInvestmentWrites ?? runtime?.mcpInvestmentWrites,
    investmentReads: options.mcpInvestmentReads ?? runtime?.mcpInvestmentReads,
    investmentHistory: options.mcpInvestmentHistory ?? runtime?.mcpInvestmentHistory,
    marketData: runtime?.marketData,
  };
}

export type MarketAuthorities = ReturnType<typeof marketAuthorities>;
