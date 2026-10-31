// Port of tests/investments/performance/perf_support.py for the store: the synthetic household (one
// brokerage account, the canonical history imported as events, no prices yet), its strategy values,
// and fake price / FX sources (no network). Every value here is invented.
import { addDays, D, type DateTime, daysBetween, parseDateTime } from "@cashu/domain";
import {
  AssetClass,
  aliasOf,
  allocationPlan,
  bucketDef,
  bucketMatch,
  type CalendarDate,
  Currencies,
  type Currency,
  type FxRate,
  fxRate,
  type Instrument,
  market,
  performance as perf,
  priceBar,
} from "@cashu/domain/investments";
import { storeWriter } from "../../../command.js";
import { createProfile } from "../../../core/commands.js";
import { createInstrument } from "../../commands/instruments.js";
import { applyRaw, brokerage, type Vault } from "../../commands/testing/fixtures.js";
import type { BackfillDeps } from "../backfill.js";

export const AS_OF: CalendarDate = "2025-09-30";
const { PLN } = Currencies;
export const { EUR, USD } = Currencies;

/** `BENCH_STRATEGY`: stocks (equity, etf) 90 %, cash 10 %, benchmark msci_acwi via BNCH.DE. */
export function benchStrategy(proxy = "BNCH.DE"): perf.PerformanceStrategy {
  const stocks = bucketDef({
    id: "stocks",
    match: bucketMatch({ assetClasses: [AssetClass.EQUITY, AssetClass.ETF] }),
  });
  const cash = bucketDef({ id: "cash", match: bucketMatch({ assetClasses: [AssetClass.CASH] }) });
  return {
    state: "valid",
    benchmark: { id: "msci_acwi", proxy },
    policy: { ...perf.DEFAULT_VALUATION_POLICY, maxPriceAgeDays: 5 },
    strategy: {
      baseCurrency: PLN,
      allocation: allocationPlan({
        buckets: [stocks, cash],
        targets: new Map([
          ["stocks", 0.9],
          ["cash", 0.1],
        ]),
      }),
    },
  };
}

/** The same strategy without its `benchmark:` section. */
export function noBenchmarkStrategy(): perf.PerformanceStrategy {
  return { ...benchStrategy(), benchmark: null };
}

/** No strategy.yaml (state `missing`: default thresholds, the profile's base currency). */
export const NO_STRATEGY: perf.PerformanceStrategy = {
  state: "missing",
  benchmark: null,
  policy: perf.DEFAULT_VALUATION_POLICY,
  strategy: null,
};

/** ABC: 100 on 2025-01-01, +0.1 PLN per calendar day. */
const abcClose = (d: CalendarDate) =>
  D("100").add(D("0.1").mul(D(String(daysBetween("2025-01-01", d)))));
/** WRLD: 100 EUR flat until 2025-03-31, then 110. */
const wrldClose = (d: CalendarDate) => (d < "2025-04-01" ? D("100") : D("110"));
/** Benchmark proxy: 50 EUR, +0.01 per calendar day from 2024-12-01. */
export const benchClose = (d: CalendarDate) =>
  D("50").add(D("0.01").mul(D(String(daysBetween("2024-12-01", d)))));

/** The fake proxy close in PLN (EUR at 4.3), as the Python test's `bench(d)`. */
export const benchPln = (d: CalendarDate): number => benchClose(d).toFloat() * 4.3;

const FETCHED_AT: DateTime = parseDateTime("2025-09-30T18:00:00Z");

/** A bar for every calendar day per Yahoo symbol; rejects a wrong instrument currency like Yahoo. */
export class FakePrices implements market.PriceSource {
  readonly id = "yahoo";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];
  readonly closes = new Map<string, (d: CalendarDate) => ReturnType<typeof D>>([
    ["ABC.WA", abcClose],
    ["WRLD.DE", wrldClose],
    ["BNCH.DE", benchClose],
  ]);
  readonly quotes = new Map<string, Currency>([
    ["ABC.WA", PLN],
    ["WRLD.DE", EUR],
    ["BNCH.DE", EUR],
  ]);

  async fetch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<market.PriceHistory> {
    const symbol = aliasOf(instrument, "yahoo") ?? "";
    this.calls.push([symbol, start, end]);
    const close = this.closes.get(symbol);
    const quote = this.quotes.get(symbol);
    if (close === undefined || quote === undefined) return market.priceHistory();
    if (instrument.currency !== quote) {
      throw new market.QuoteCurrencyMismatchException("yahoo", `quoted in ${quote}`, {
        quoteCurrency: quote,
        instrumentCurrency: instrument.currency,
      });
    }
    const n = daysBetween(start, end) + 1;
    const bars = Array.from({ length: Math.max(0, n) }, (_, i) => {
      const date = addDays(start, i);
      return priceBar({
        instrumentId: instrument.id,
        date,
        close: close(date),
        source: "yahoo",
        fetchedAt: FETCHED_AT,
        currency: quote,
      });
    });
    return market.priceHistory({ bars, currency: quote });
  }
}

/** EUR at 4.3 PLN every calendar day. */
export class FakeFx implements market.FxSource {
  readonly id = "nbp";
  readonly calls: [string, CalendarDate, CalendarDate][] = [];

  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    this.calls.push([quote, start, end]);
    if (quote !== EUR) return [];
    return Array.from({ length: daysBetween(start, end) + 1 }, (_, i) =>
      fxRate({ quote: EUR, date: addDays(start, i), rate: D("4.3"), source: "nbp" }),
    );
  }
}

let seq = 0;

/** `invTxn.imported` of the canonical import (`perf_support.ROWS`). */
function imported(v: Vault, account: string, data: Record<string, unknown>) {
  seq += 1;
  const hash = seq.toString(16).padStart(64, "0");
  return {
    type: "invTxn.imported",
    gid: v.det("inv_transactions", [account, hash]),
    data: {
      account,
      batch: null,
      settleDate: null,
      instrument: null,
      quantity: null,
      price: null,
      currency: "PLN",
      grossAmount: "0",
      fee: "0",
      tax: "0",
      cashCurrency: "PLN",
      fxRate: null,
      splitRatio: null,
      note: null,
      source: "import",
      externalRef: null,
      dedupHash: hash,
      ...data,
    },
  };
}

/** One more imported transaction of the household's account. */
export function importRow(v: Vault, account: string, data: Record<string, unknown>) {
  applyRaw(v, [imported(v, account, data)]);
}

export interface Household {
  readonly account: string;
  readonly abc: string;
  readonly wrld: string;
}

/**
 * `household()`: a profile with one brokerage account and the synthetic history imported (no prices
 * yet). The importer's market resolution gave ABC a guessed `ABC.WA` and WRLD a guessed `WRLD.DE`.
 */
export function household(v: Vault, name = "Inwestor"): Household {
  v.value(createProfile, {
    slug: name.toLowerCase(),
    name,
    baseCurrency: "PLN",
    modules: ["investments"],
  });
  const account = brokerage(v, "Konto Test");
  const abc = v.value(createInstrument, {
    name: "ABC Example SA",
    currency: "PLN",
    assetClass: "equity",
    symbol: "ABC",
    isin: "PLABC0000016",
    mic: "XWAR",
    aliases: [{ namespace: "yahoo", value: "ABC.WA", guessed: true }],
  }).gid;
  const wrld = v.value(createInstrument, {
    name: "World Equity UCITS ETF",
    currency: "EUR",
    assetClass: "etf",
    symbol: "WRLD",
    isin: "IE00BEXAMPL1",
    mic: "XETR",
    aliases: [{ namespace: "yahoo", value: "WRLD.DE", guessed: true }],
  }).gid;
  applyRaw(v, [
    imported(v, account, {
      type: "deposit",
      tradeDate: "2025-01-02",
      cashAmount: "10000.00",
      createdAt: "2025-01-02T09:00:00.000Z",
    }),
    imported(v, account, {
      type: "buy",
      tradeDate: "2025-01-03",
      instrument: abc,
      quantity: "50",
      price: "100.00",
      grossAmount: "5000.00",
      cashAmount: "-5000.00",
      createdAt: "2025-01-03T10:00:00.000Z",
    }),
    imported(v, account, {
      type: "buy",
      tradeDate: "2025-01-06",
      instrument: wrld,
      quantity: "10",
      price: "100.00",
      currency: "EUR",
      grossAmount: "1000.00",
      cashAmount: "-4300.00",
      cashCurrency: "PLN",
      fxRate: "4.3",
      createdAt: "2025-01-06T10:00:00.000Z",
    }),
    imported(v, account, {
      type: "sell",
      tradeDate: "2025-06-02",
      instrument: abc,
      quantity: "50",
      price: "120.00",
      grossAmount: "6000.00",
      cashAmount: "6000.00",
      createdAt: "2025-06-02T10:00:00.000Z",
    }),
    imported(v, account, {
      type: "deposit",
      tradeDate: "2025-07-01",
      cashAmount: "2000.00",
      createdAt: "2025-07-01T09:00:00.000Z",
    }),
  ]);
  return { account, abc, wrld };
}

/** Backfill dependencies of a vault over a shared cache and the given fake sources. */
export function backfillDeps(
  v: Vault,
  cache: market.PriceCache,
  options: {
    readonly strategy?: perf.PerformanceStrategy;
    readonly prices?: market.PriceSource;
    readonly fx?: market.FxSource;
    readonly profile?: string;
  } = {},
): BackfillDeps {
  return {
    store: v.store,
    writer: storeWriter(v.store),
    env: v.env,
    cache,
    sources: { prices: options.prices ?? new FakePrices(), fx: options.fx ?? new FakeFx() },
    strategy: options.strategy ?? benchStrategy(),
    asOf: AS_OF,
    profile: options.profile ?? "inwestor",
  };
}
