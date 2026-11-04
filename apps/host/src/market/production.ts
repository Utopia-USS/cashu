/** Host-owned public market transport and one device-local cache for every native vault. */
import { performance } from "node:perf_hooks";
import { parseDateTime } from "@cashu/domain";
import type { CalendarDate, market } from "@cashu/domain/investments";
import {
  type FetchLike,
  MarketHttp,
  NbpFxSource,
  OpenFigiIsinLookup,
  type Sleep,
  standardCompositeSource,
  YahooPriceSource,
  YahooSymbolSearch,
} from "@cashu/market";
import {
  type InvestmentAsyncCapabilities,
  type InvestmentHistoryReads,
  type InvestmentReads,
  type InvestmentWriteServices,
  investmentSearchIo,
  investmentWatchIo,
  type NativeToolStore,
  type ResearchServices,
  type ToolContext,
} from "@cashu/mcp";
import type { SqlDriver } from "@cashu/store";
import { SqlCalendarCache, SqlPriceCache } from "@cashu/store/investments/local";
import { allInstruments } from "@cashu/store/investments/queries";
import type { ResearchScreenExtraSources } from "@cashu/store/investments/research-screen";
import type { InvestmentMarketSource, MarketInput } from "@cashu/store/investments/screen-sources";
import { type DailySources, InstrumentSearch } from "@cashu/store/investments/services";
import type { Read } from "@cashu/store/query";
import type { OpenVault } from "../stores.js";
import type { WorkspaceProvider } from "../workspace/index.js";
import { cachedInstrumentMarketData } from "./cachedData.js";
import { nativeInvestmentMcp } from "./mcpProduction.js";
import { cachedResearchSources } from "./researchCache.js";

export interface ProductionMarketInput {
  readonly stores: {
    readonly device: { readonly driver: SqlDriver };
    readonly vaults: ReadonlyMap<string, OpenVault>;
  };
  readonly isCurrent: (vault: OpenVault) => boolean;
  readonly now: () => number;
  /** Product entry supplies global fetch; tests supply a fake. */
  readonly fetch: FetchLike;
  /** Test clock control; production uses a real timer. */
  readonly sleep?: Sleep;
  /** Existing native language policy, supplied by the product entry. */
  readonly language?: () => "pl" | "en";
  readonly workspace?: WorkspaceProvider;
}

export interface ProductionMarket {
  readonly prices: SqlPriceCache;
  readonly market: InvestmentMarketSource;
  readonly research: ResearchScreenExtraSources;
  marketForVault(read: Read, vault: string): MarketInput;
  marketData(read: Read, vault: string): market.CachedMarketData | null;
  readonly sources: (vaultIds: readonly string[]) => DailySources;
  readonly fxNewest: () => string | null;
  investmentAsync(vaultId: string): InvestmentAsyncCapabilities | undefined;
  readonly mcpResearch?: (context: ToolContext<NativeToolStore>) => ResearchServices;
  readonly mcpInvestmentReads?: (context: ToolContext<NativeToolStore>) => InvestmentReads;
  readonly mcpInvestmentHistory?: (context: ToolContext<NativeToolStore>) => InvestmentHistoryReads;
  readonly mcpInvestmentWrites?: (context: ToolContext<NativeToolStore>) => InvestmentWriteServices;
  close(): void;
}

/** A network holder is always an exact, current native session with current lease evidence. */
export function createProductionMarket(input: ProductionMarketInput): ProductionMarket {
  const prices = new SqlPriceCache(input.stores.device.driver);
  const calendar = new SqlCalendarCache(input.stores.device.driver);
  const research = cachedResearchSources({
    prices,
    calendar,
    vaults: input.stores.vaults,
    isCurrent: input.isCurrent,
    workspace: input.workspace,
  });
  let closed = false;
  const vaultFor = (id: string): OpenVault | undefined => input.stores.vaults.get(id);
  const marketImages = new Map<
    string,
    {
      vault: OpenVault;
      version: number;
      instruments: string;
      image: ReturnType<typeof cachedInstrumentMarketData>;
    }
  >();
  const imageFor = (read: Read, id: string) => {
    const vault = vaultFor(id);
    if (vault === undefined) throw new Error("native_market_vault_unavailable");
    const instruments = allInstruments(read);
    const fingerprint = JSON.stringify(instruments);
    const version = prices.version();
    const cached = marketImages.get(id);
    if (cached?.vault === vault && cached.version === version && cached.instruments === fingerprint)
      return cached.image;
    const image = cachedInstrumentMarketData(instruments, id, prices);
    marketImages.set(id, { vault, version, instruments: fingerprint, image });
    return image;
  };
  const visible = (read: Read, id: string): boolean => {
    const vault = vaultFor(id);
    return (
      !closed &&
      read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid === id &&
      vault?.mode === "native" &&
      input.isCurrent(vault)
    );
  };
  const marketForVault = (read: Read, id: string): MarketInput => {
    if (!visible(read, id)) throw new Error("native_market_vault_unavailable");
    return { marketData: imageFor(read, id) };
  };
  const search = new InstrumentSearch(input.now);
  const mcp =
    input.language === undefined
      ? null
      : nativeInvestmentMcp({
          prices,
          calendar,
          marketForVault,
          language: input.language,
          vaults: input.stores.vaults,
          isCurrent: input.isCurrent,
        });
  const current = (id: string): boolean => {
    const vault = vaultFor(id);
    try {
      return (
        !closed &&
        vault?.mode === "native" &&
        input.isCurrent(vault) &&
        vault.native?.canFetchPublicMarket() === true
      );
    } catch {
      return false;
    }
  };
  const fetchFor =
    (allowed: () => boolean, vaultIds: readonly string[]): FetchLike =>
    async (url, init) => {
      if (!allowed()) throw new Error("market_fetch_authority_unavailable");
      const releases: (() => void)[] = [];
      const release = () => {
        for (const end of releases.splice(0)) end();
      };
      try {
        for (const id of vaultIds) {
          const vault = vaultFor(id);
          if (vault?.mode !== "native" || !current(id)) continue;
          const end = vault.native.beginFetch();
          if (!end) throw new Error("market_fetch_authority_unavailable");
          releases.push(end);
        }
        if (releases.length === 0 || !allowed())
          throw new Error("market_fetch_authority_unavailable");
        const response = await input.fetch(url, init);
        return {
          status: response.status,
          headers: response.headers,
          text: async () => {
            try {
              const body = await response.text();
              if (!allowed()) throw new Error("market_fetch_authority_unavailable");
              return body;
            } finally {
              release();
            }
          },
        };
      } catch (error) {
        release();
        throw error;
      }
    };
  const httpFor = (allowed: () => boolean, vaultIds: readonly string[]) =>
    new MarketHttp({
      fetch: fetchFor(allowed, vaultIds),
      sleep:
        input.sleep ??
        ((seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1_000))),
      clock: () => performance.now() / 1_000,
    });
  const utcClock = () => parseDateTime(new Date(input.now()).toISOString());
  const sources = (vaultIds: readonly string[]): DailySources => {
    const original = new Map(vaultIds.map((id) => [id, vaultFor(id)]));
    const allowed = () =>
      [...original].some(
        ([id, vault]) => vault !== undefined && vaultFor(id) === vault && current(id),
      );
    if (!allowed()) throw new Error("market_fetch_authority_unavailable");
    const scoped = (consumer: () => boolean) => {
      const http = httpFor(() => allowed() && consumer(), vaultIds);
      const yahoo = new YahooPriceSource(http, { clock: utcClock });
      const nbp = new NbpFxSource(http, { clock: utcClock });
      return {
        priceSource: standardCompositeSource(http, { clock: utcClock }),
        fxSource: nbp,
        spark: yahoo,
        tableFx: nbp,
      };
    };
    const base = scoped(allowed);
    return {
      ...base,
      macro: base.spark,
      scoped,
      close() {},
    };
  };
  const marketSource: InvestmentMarketSource = {
    changes: { subscribe: (listener) => prices.subscribe(listener) },
    current(read: Read) {
      const id = read<{ gid: string }>("SELECT gid FROM profiles")[0]?.gid;
      if (id === undefined || closed) return null;
      return visible(read, id) ? marketForVault(read, id) : null;
    },
    newestRateDate: () => prices.newestFxDate(),
  };
  return {
    prices,
    market: marketSource,
    research: research.sources,
    marketForVault,
    marketData: (read, vault) => (visible(read, vault) ? imageFor(read, vault).data : null),
    ...(mcp === null
      ? {}
      : {
          mcpResearch: mcp.research,
          mcpInvestmentWrites: mcp.investmentWrites,
          mcpInvestmentReads: mcp.investmentReads,
          mcpInvestmentHistory: mcp.investmentHistory,
        }),
    sources,
    fxNewest: () => prices.newestFxDate(),
    investmentAsync(vaultId) {
      const vault = vaultFor(vaultId);
      if (vault?.mode !== "native" || !input.isCurrent(vault) || closed) return undefined;
      const allowed = () => current(vaultId) && vaultFor(vaultId) === vault;
      const searchSources = () => {
        const http = httpFor(allowed, [vaultId]);
        return {
          symbols: new YahooSymbolSearch(http),
          isin: new OpenFigiIsinLookup(http),
          close() {},
        };
      };
      const watch = {
        async chart(symbol: string, start: CalendarDate, end: CalendarDate) {
          if (!allowed()) throw new Error("market_fetch_authority_unavailable");
          const quote = await new YahooPriceSource(httpFor(allowed, [vaultId]), {
            clock: utcClock,
          }).chart(symbol, start, end);
          if (!allowed()) throw new Error("market_fetch_authority_unavailable");
          return quote;
        },
        async search(query: string) {
          const answer = await search.remoteHits(query, searchSources);
          if (!allowed()) throw new Error("market_fetch_authority_unavailable");
          return answer.hits;
        },
      };
      let publication: ReturnType<NonNullable<typeof vault.native>["blobPublication"]> = null;
      try {
        publication = vault.native?.blobPublication() ?? null;
      } catch {
        /* Unavailable authority. */
      }
      return {
        vault: vaultId,
        search: investmentSearchIo(vaultId, search, searchSources, allowed),
        watch: investmentWatchIo(
          vaultId,
          watch,
          {
            upsertBars(key, bars, now) {
              if (!allowed() || key.provider !== "yahoo")
                throw new Error("market_cache_authority_unavailable");
              prices.upsertBars(key, bars, now);
            },
          },
          allowed,
        ),
        ...(publication?.isCurrent() ? { imports: publication } : {}),
      };
    },
    close() {
      closed = true;
      marketImages.clear();
      research.close();
    },
  };
}
