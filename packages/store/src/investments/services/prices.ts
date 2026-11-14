/** Network orchestration over injected domain ports. No SQL writer is held across an await. */
import { addDays, type DateTime, toStorage } from "@cashu/domain";
import {
  asInstrumentId,
  type CalendarDate,
  Currencies,
  type Currency,
  type Instrument,
  type InstrumentId,
  market,
} from "@cashu/domain/investments";
import type { TransactionalPriceCache } from "../local/priceCache.js";
import type { PriceNeeds } from "./priceNeeds.js";

export interface FetchAuthority {
  isHolder(): boolean;
}
export interface PriceVault {
  readonly vault: string;
  readonly needs: PriceNeeds;
  readonly authority: FetchAuthority | null;
}
export class DailyPriceLock {
  private held = false;
  tryAcquire(): (() => void) | null {
    if (this.held) return null;
    this.held = true;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.held = false;
      }
    };
  }
}
export interface RefreshPriceDeps {
  readonly vaults: readonly PriceVault[];
  readonly prices: market.PriceCache | TransactionalPriceCache;
  readonly priceSource: market.PriceSource;
  readonly fxSource: market.FxSource;
  readonly spark?: market.SparkSource | null;
  readonly tableFx?: market.TableFxSource | null;
  /** Bind a short request to its exact current consumers, including source fallback and retries. */
  readonly scoped?: (
    allowed: () => boolean,
  ) => Pick<RefreshPriceDeps, "priceSource" | "fxSource" | "spark" | "tableFx">;
  readonly asOf: CalendarDate;
  readonly now: DateTime;
  readonly workers?: number;
  /** Daily needs historical lot FX; prices-only deliberately does not. */
  readonly includeFxHistory?: boolean;
}
export interface PriceRefreshResult {
  readonly reports: ReadonlyMap<string, market.FetchReport>;
  readonly refused: readonly string[];
  readonly stored: market.CacheWriteStats;
  readonly requests: {
    readonly spark: number;
    readonly batched: number;
    readonly perInstrument: number;
    readonly fxTables: number;
  };
}
function authorized(v: PriceVault): boolean {
  try {
    return v.authority?.isHolder() === true;
  } catch {
    return false;
  }
}
function requireConsumer(consumers: readonly PriceVault[]): void {
  if (!consumers.some(authorized)) throw new Error("market authority unavailable");
}
/** Caller must hold the shared daily/price lock. Consumers retain vault provenance throughout. */
export async function refreshPriceNeeds(deps: RefreshPriceDeps): Promise<PriceRefreshResult> {
  const active = deps.vaults.filter(authorized);
  const groups = new Map<
    string,
    { instrument: Instrument; consumers: PriceVault[]; members: Map<string, Instrument[]> }
  >();
  const currencyConsumers = new Map<Currency, PriceVault[]>();
  for (const v of active) {
    for (const i of [...v.needs.watched.values(), ...v.needs.instruments.values()]) {
      const key = JSON.stringify([
        market.marketSymbolsOf(i),
        i.currency,
        i.status,
        i.valuationMode,
        market.defaultPriceSourceOrder(i),
      ]);
      // Alias-less subjects must never collapse into another instrument.
      const unique = market.marketSymbolsOf(i).length === 0 ? `${v.vault}:${i.id}` : key;
      const group: {
        instrument: Instrument;
        consumers: PriceVault[];
        members: Map<string, Instrument[]>;
      } = groups.get(unique) ?? {
        instrument: { ...i, id: asInstrumentId(`market:${groups.size}`) },
        consumers: [],
        members: new Map<string, Instrument[]>(),
      };
      group.consumers.push(v);
      group.members.set(v.vault, [...(group.members.get(v.vault) ?? []), i]);
      groups.set(unique, group);
    }
    for (const c of v.needs.currencies)
      if (c !== Currencies.PLN) {
        const list = currencyConsumers.get(c) ?? [];
        list.push(v);
        currencyConsumers.set(c, list);
      }
  }
  const byId = new Map([...groups.values()].map((g) => [g.instrument.id, g]));
  const instruments = [...byId.values()].map((g) => g.instrument);
  const stored = market.cachedMarketData(deps.prices, instruments);
  const guardPrices: market.PriceSource = {
    id: deps.priceSource.id,
    async fetch(i, start, end) {
      const consumers = byId.get(i.id)?.consumers ?? [];
      requireConsumer(consumers);
      const source =
        deps.scoped?.(() => consumers.some(authorized)).priceSource ?? deps.priceSource;
      const result = await source.fetch(i, start, end);
      requireConsumer(consumers);
      return result;
    },
  };
  const guardFx: market.FxSource = {
    id: deps.fxSource.id,
    async rates(c, start, end) {
      const consumers = currencyConsumers.get(c) ?? [];
      requireConsumer(consumers);
      const source = deps.scoped?.(() => consumers.some(authorized)).fxSource ?? deps.fxSource;
      const result = await source.rates(c, start, end);
      requireConsumer(consumers);
      return result;
    },
  };
  const spark: market.SparkSource | null =
    deps.spark == null
      ? null
      : {
          parseHistory: (...args) => deps.spark?.parseHistory(...args) ?? market.priceHistory(),
          async spark(symbols) {
            const allowed = (symbol: string) =>
              [...groups.values()].some(
                (g) =>
                  market
                    .marketSymbolsOf(g.instrument)
                    .some((k) => k.provider === "yahoo" && k.symbol === symbol) &&
                  g.consumers.some(authorized),
              );
            const requested = symbols.filter(allowed);
            if (requested.length === 0) return new Map();
            const source = deps.scoped?.(() => requested.every(allowed)).spark ?? deps.spark;
            const answer = await source?.spark(requested);
            return new Map([...(answer ?? [])].filter(([symbol]) => allowed(symbol)));
          },
        };
  const table: market.TableFxSource | null =
    deps.tableFx == null
      ? null
      : {
          maxDaysPerRequest: deps.tableFx.maxDaysPerRequest,
          async tableRates(start, end) {
            requireConsumer([...currencyConsumers.values()].flat());
            const activeCurrencies = [...currencyConsumers.keys()];
            const source =
              deps.scoped?.(() =>
                activeCurrencies.every((c) => currencyConsumers.get(c)?.some(authorized)),
              ).tableFx ?? deps.tableFx;
            const answer = await source?.tableRates(start, end);
            return new Map(
              [...(answer ?? [])].filter(([c]) => currencyConsumers.get(c)?.some(authorized)),
            );
          },
        };
  const lastCloses = new Map<
    InstrumentId,
    readonly [CalendarDate, ReturnType<typeof stored.series>[number]["close"]]
  >();
  for (const i of instruments) {
    const b = stored.series(i.id).at(-1);
    if (b) lastCloses.set(i.id, [b.date, b.close]);
  }
  const prices = new market.BatchedPriceSource(spark, guardPrices, { lastCloses });
  const fx = new market.BatchedFxSource(table, guardFx);
  await prices.prefetch(instruments.filter((i) => byId.get(i.id)?.consumers.some(authorized)));
  const known = [...currencyConsumers.keys()]
    .map((c) => stored.lastRateDate(c))
    .filter((d): d is CalendarDate => d !== null)
    .sort();
  if (known[0] !== undefined && [...currencyConsumers.values()].flat().some(authorized))
    await fx.prefetch([known[0], addDays(deps.asOf, -30)].sort()[1] ?? deps.asOf, deps.asOf);
  const splitDates = new Map<InstrumentId, CalendarDate>();
  const fxHistoryFrom = new Map<Currency, CalendarDate>();
  for (const g of groups.values())
    for (const v of g.consumers.filter(authorized)) {
      for (const member of g.members.get(v.vault) ?? []) {
        const d = v.needs.splitDates.get(member.id);
        if (d !== undefined && d > (splitDates.get(g.instrument.id) ?? ""))
          splitDates.set(g.instrument.id, d);
      }
    }
  for (const v of deps.includeFxHistory === false ? [] : active.filter(authorized))
    for (const [c, d] of v.needs.fxHistoryFrom)
      if (d < (fxHistoryFrom.get(c) ?? "9999-12-31")) fxHistoryFrom.set(c, d);
  const report = await new market.MarketDataRefresher(prices, fx, {
    workers: deps.workers ?? 1,
  }).refresh(stored, instruments, [...currencyConsumers.keys()], deps.asOf, {
    splitDates,
    fxHistoryFrom,
  });
  const safe = market.fetchReport(
    deps.asOf,
    report.instruments.filter((i) => byId.get(i.instrumentId)?.consumers.some(authorized)),
    report.fx.filter((f) => currencyConsumers.get(f.currency)?.some(authorized)),
  );
  const writable = (key: market.MarketSymbol) =>
    [...groups.values()].some(
      (g) =>
        market
          .marketSymbolsOf(g.instrument)
          .some((k) => k.provider === key.provider && k.symbol === key.symbol) &&
        g.consumers.some(authorized),
    );
  const guardedCache: market.PriceCache = {
    version: () => deps.prices.version(),
    bars: (key) => deps.prices.bars(key),
    rates: (p, c) => deps.prices.rates(p, c),
    upsertBars: (key, bars, now) => {
      if (writable(key)) deps.prices.upsertBars(key, bars, now);
    },
    deleteBars: (key, from, to) => {
      if (writable(key)) deps.prices.deleteBars(key, from, to);
    },
    upsertRates: (p, c, rates, now) => {
      if (currencyConsumers.get(c)?.some(authorized)) deps.prices.upsertRates(p, c, rates, now);
    },
  };
  const apply = () => market.applyFetchReport(guardedCache, safe, instruments, deps.now);
  const written = "batch" in deps.prices ? deps.prices.batch(apply) : apply();
  const reports = new Map<string, market.FetchReport>();
  for (const v of active.filter(authorized))
    reports.set(
      v.vault,
      market.fetchReport(
        deps.asOf,
        safe.instruments.flatMap((item) => {
          const members = byId.get(item.instrumentId)?.members.get(v.vault) ?? [];
          return members.map((member) => ({
            ...item,
            instrumentId: member.id,
            label: member.symbol || member.name,
            bars: item.bars.map((b) => ({ ...b, instrumentId: member.id })),
          }));
        }),
        safe.fx.filter((f) => v.needs.currencies.has(f.currency)),
      ),
    );
  return {
    reports,
    refused: deps.vaults.filter((v) => !authorized(v)).map((v) => v.vault),
    stored: written,
    requests: {
      spark: prices.requests,
      batched: prices.batched,
      perInstrument: prices.fallbacks,
      fxTables: fx.requests,
    },
  };
}

export interface PricesResult {
  readonly status: "ok" | "partial" | "failed" | "busy" | "disabled" | "refused";
  readonly cached: boolean;
  readonly finishedAt: number;
  readonly updated: number;
  readonly skipped: number;
  readonly fxUpdated: number;
  readonly errors: readonly string[];
  readonly refresh?: PriceRefreshResult;
}
/** Per-process/per-vault result cache. Force bypasses only the five-minute throttle. */
export class PricesService {
  private readonly lock: DailyPriceLock;
  private readonly last = new Map<string, PricesResult>();
  constructor(lock: DailyPriceLock) {
    this.lock = lock;
  }
  async run(
    deps: Omit<RefreshPriceDeps, "vaults" | "now" | "includeFxHistory"> & {
      readonly vault: PriceVault;
      readonly enabled: boolean;
      readonly force?: boolean;
      readonly clock: () => DateTime;
      readonly close: () => void;
    },
  ): Promise<PricesResult> {
    const milliseconds = () => Date.parse(`${toStorage(deps.clock())}Z`);
    const ms = milliseconds();
    const result = (status: PricesResult["status"]): PricesResult => ({
      status,
      cached: false,
      finishedAt: milliseconds(),
      updated: 0,
      skipped: 0,
      fxUpdated: 0,
      errors: [],
    });
    if (!deps.enabled) return result("disabled");
    if (!authorized(deps.vault)) return result("refused");
    const old = this.last.get(deps.vault.vault);
    if (!deps.force && old !== undefined && ms >= old.finishedAt && ms - old.finishedAt < 300_000)
      return { ...old, cached: true };
    const release = this.lock.tryAcquire();
    if (release === null) return result("busy");
    let answer: PricesResult;
    try {
      let refresh: PriceRefreshResult;
      try {
        refresh = await refreshPriceNeeds({
          ...deps,
          vaults: [deps.vault],
          now: deps.clock(),
          includeFxHistory: false,
        });
      } finally {
        deps.close();
      }
      const report = refresh.reports.get(deps.vault.vault);
      const updated =
        report?.instruments.filter((i) => i.status === market.FetchStatus.OK && i.bars.length > 0)
          .length ?? 0;
      const skipped =
        report?.instruments.filter(
          (i) =>
            i.status !== market.FetchStatus.ERROR &&
            !(i.status === market.FetchStatus.OK && i.bars.length > 0),
        ).length ?? 0;
      const fxUpdated =
        report?.fx.filter((f) => f.status === market.FetchStatus.OK && f.rates.length > 0).length ??
        0;
      const errors = report === undefined ? [] : market.reportErrorMessages(report);
      const status =
        report === undefined
          ? "refused"
          : errors.length === 0
            ? "ok"
            : updated + skipped + fxUpdated === 0
              ? "failed"
              : "partial";
      answer = { ...result(status), updated, skipped, fxUpdated, errors, refresh };
    } catch {
      answer = { ...result("failed"), errors: ["market_refresh_failed"] };
    } finally {
      release();
    }
    this.last.set(deps.vault.vault, answer);
    return answer;
  }
}
