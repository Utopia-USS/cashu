/**
 * Batched quotes for the lightweight price refresh (P10, `market/batched.py`): Yahoo's spark endpoint for
 * many symbols per request and one NBP table request for every currency, served to the refresher
 * through the ordinary `PriceSource` / `FxSource` contracts, so the refresh plans, reports and stores
 * exactly like the daily check.
 *
 * Whatever a batch cannot answer goes to the fallback source (the daily check's per-instrument path):
 * no yahoo alias or a stooq-first listing (XWAR), a window older than the batch (nothing stored yet, or
 * the last stored bar before the spark window), a symbol Yahoo left out, a quote currency mismatch, or
 * a suspected split (the spark close on the newest stored day differs from the stored close by more
 * than `SPLIT_GUARD`: Yahoo adjusted its history, and the per-instrument chart reports the split, so
 * the refresher re-fetches the stored window). Spark has no split events of its own.
 */

import { addDays } from "../../dates.js";
import { D, type Decimal, ONE, ZERO } from "../../decimal.js";
import {
  AliasNamespace,
  aliasOf,
  fetchesMarketData,
  type Instrument,
} from "../domain/instrument.js";
import type { FxRate } from "../domain/marketData.js";
import {
  type CalendarDate,
  type Currency,
  comparePyStr,
  type InstrumentId,
} from "../domain/values.js";
import {
  defaultPriceSourceOrder,
  isBlockAware,
  type MarketLog,
  type PriceSourceOrder,
} from "./composite.js";
import {
  type FxSource,
  type PriceHistory,
  type PriceSource,
  priceHistory,
  reprError,
  SourceBlockedException,
  SourceException,
} from "./sources.js";

/** Symbols per spark request. */
export const SPARK_CHUNK = 20;

/**
 * Relative difference between the spark close and the stored close of the same day above which the
 * instrument goes the per-instrument way (a split or another history adjustment).
 */
export const SPLIT_GUARD: Decimal = D("0.25");

/** Python `date.min`: the batch is parsed from the beginning of time up to the planned end. */
const DATE_MIN: CalendarDate = "0001-01-01";

const SILENT: MarketLog = { debug() {}, info() {}, warn() {} };

/** What the batched price source needs of Yahoo (`@cashu/market` `YahooPriceSource`). */
export interface SparkSource {
  /** Chart bodies per symbol Yahoo answered for, one request for all `symbols`. */
  spark(symbols: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** `parseYahooHistory` with the source's fetch time. */
  parseHistory(
    body: string,
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
    symbol: string | null,
  ): PriceHistory;
}

/** What the batched FX source needs of NBP (`@cashu/market` `NbpFxSource`). */
export interface TableFxSource {
  readonly maxDaysPerRequest: number;
  /** Every table A currency over `start..end` in one request. */
  tableRates(
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<ReadonlyMap<Currency, readonly FxRate[]>>;
}

export interface BatchedPriceSourceOptions {
  /** The newest stored `(date, close)` per instrument (the split guard). */
  readonly lastCloses?: ReadonlyMap<InstrumentId, readonly [CalendarDate, Decimal]>;
  readonly order?: PriceSourceOrder;
  readonly chunk?: number;
  readonly log?: MarketLog;
}

/** Serves `fetch` from spark batches fetched by `prefetch`, else from `fallback`. */
export class BatchedPriceSource implements PriceSource {
  readonly id = "batched";
  /** Spark requests made. */
  requests = 0;
  /** Instruments answered from a batch. */
  batched = 0;
  /** Instruments sent to the fallback source. */
  fallbacks = 0;
  readonly batchErrors: string[] = [];

  private readonly yahoo: SparkSource | null;
  private readonly fallback: PriceSource;
  private readonly last: ReadonlyMap<InstrumentId, readonly [CalendarDate, Decimal]>;
  private readonly order: PriceSourceOrder;
  private readonly chunk: number;
  private readonly log: MarketLog;
  private readonly bodies = new Map<string, string>();
  private probeClaimed = false;
  private readonly probeDone: Promise<void>;
  private finishProbe: () => void = () => {};

  constructor(
    yahoo: SparkSource | null,
    fallback: PriceSource,
    options: BatchedPriceSourceOptions = {},
  ) {
    const chunk = options.chunk ?? SPARK_CHUNK;
    if (chunk <= 0) throw new RangeError("chunk must be positive");
    this.yahoo = yahoo;
    this.fallback = fallback;
    this.last = new Map(options.lastCloses ?? []);
    this.order = options.order ?? defaultPriceSourceOrder;
    this.chunk = chunk;
    this.log = options.log ?? SILENT;
    this.probeDone = new Promise((resolve) => {
      this.finishProbe = resolve;
    });
  }

  private inBatch(instrument: Instrument): boolean {
    const symbol = aliasOf(instrument, AliasNamespace.YAHOO);
    return symbol !== null && this.bodies.has(symbol);
  }

  private blockedSources(): ReadonlySet<string> {
    return isBlockAware(this.fallback) ? this.fallback.blocked() : new Set();
  }

  /**
   * Yahoo is the instrument's first source with an alias that is not blocked in this run (spark only
   * replaces that path: a stooq-first listing goes per instrument until stooq is blocked).
   */
  batchable(instrument: Instrument): boolean {
    if (this.yahoo === null || !fetchesMarketData(instrument)) return false;
    if (aliasOf(instrument, AliasNamespace.YAHOO) === null) return false;
    const blocked = this.blockedSources();
    const first = this.order(instrument).find(
      (s) => aliasOf(instrument, s) !== null && !blocked.has(s),
    );
    return first === AliasNamespace.YAHOO;
  }

  /**
   * Joins the spark request: a yahoo alias and a market-data instrument (a stooq-first one is answered
   * from the batch only once stooq is blocked).
   */
  private prefetchable(instrument: Instrument): boolean {
    return (
      this.yahoo !== null &&
      fetchesMarketData(instrument) &&
      aliasOf(instrument, AliasNamespace.YAHOO) !== null
    );
  }

  /**
   * One spark request per `chunk` symbols of the batchable instruments. A failed chunk only sends its
   * instruments to the fallback; a blocked source stops batching.
   */
  async prefetch(instruments: Iterable<Instrument>): Promise<void> {
    if (this.yahoo === null) return;
    const unique = new Set<string>();
    for (const instrument of instruments) {
      if (!this.prefetchable(instrument)) continue;
      unique.add(aliasOf(instrument, AliasNamespace.YAHOO) as string);
    }
    const symbols = [...unique].sort(comparePyStr);
    for (let start = 0; start < symbols.length; start += this.chunk) {
      const chunk = symbols.slice(start, start + this.chunk);
      this.requests += 1;
      try {
        for (const [symbol, body] of await this.yahoo.spark(chunk)) this.bodies.set(symbol, body);
      } catch (error) {
        if (error instanceof SourceBlockedException) {
          this.batchErrors.push(error.detail);
          this.log.info(`spark blocked, the rest goes per instrument: ${error.detail}`);
          break;
        }
        if (error instanceof SourceException) {
          this.batchErrors.push(error.detail);
          this.log.info(`spark chunk failed: ${error.detail}`);
        } else {
          // the fallback still answers
          this.batchErrors.push(reprError(error));
          this.log.warn("spark chunk failed unexpectedly");
        }
      }
    }
  }

  async fetch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): Promise<PriceHistory> {
    let answer = this.fromBatch(instrument, start, end);
    if (answer === null && this.inBatch(instrument)) {
      // A listing whose first source is another one (stooq for XWAR): the first such fetch probes that
      // source alone; the others wait for it, so once it turns out blocked they are answered from the
      // batch instead of all probing it at once (refresher workers). The probe settles: every request
      // of the fallback is bounded by the HTTP timeout and retries.
      const probe = !this.probeClaimed;
      this.probeClaimed = true;
      if (probe) {
        try {
          this.fallbacks += 1;
          return await this.fallback.fetch(instrument, start, end);
        } finally {
          this.finishProbe();
        }
      }
      await this.probeDone;
      answer = this.fromBatch(instrument, start, end);
    }
    if (answer !== null) {
      this.batched += 1;
      return answer;
    }
    this.fallbacks += 1;
    return this.fallback.fetch(instrument, start, end);
  }

  private fromBatch(
    instrument: Instrument,
    start: CalendarDate,
    end: CalendarDate,
  ): PriceHistory | null {
    const symbol = aliasOf(instrument, AliasNamespace.YAHOO);
    const body = symbol && this.batchable(instrument) ? this.bodies.get(symbol) : undefined;
    if (body === undefined || this.yahoo === null) return null;
    let full: PriceHistory;
    try {
      full = this.yahoo.parseHistory(body, instrument, DATE_MIN, end, symbol);
    } catch (error) {
      // the per-instrument path reports it (unknown symbol, currency mismatch)
      if (error instanceof SourceException) return null;
      throw error;
    }
    const first = full.bars[0];
    if (first === undefined || first.date > start) return null; // the batch does not reach back
    const last = this.last.get(instrument.id);
    if (last !== undefined) {
      const [on, close] = last;
      const sameDay = full.bars.find((b) => b.date === on);
      if (sameDay !== undefined && close.gt(ZERO)) {
        const change = sameDay.close.div(close).sub(ONE).abs();
        if (change.gt(SPLIT_GUARD)) return null;
      }
    }
    return priceHistory({
      bars: full.bars.filter((b) => start <= b.date && b.date <= end),
      currency: full.currency,
    });
  }
}

/**
 * Serves `rates` from one NBP table request (`prefetch`) when the asked range lies within it, else
 * from `fallback` (the per-currency request).
 */
export class BatchedFxSource implements FxSource {
  requests = 0;
  readonly batchErrors: string[] = [];
  private readonly nbp: TableFxSource | null;
  private readonly fallback: FxSource;
  private readonly log: MarketLog;
  private window: readonly [CalendarDate, CalendarDate] | null = null;
  private tables: ReadonlyMap<Currency, readonly FxRate[]> = new Map();

  constructor(
    nbp: TableFxSource | null,
    fallback: FxSource,
    options: { readonly log?: MarketLog } = {},
  ) {
    this.nbp = nbp;
    this.fallback = fallback;
    this.log = options.log ?? SILENT;
  }

  get id(): string {
    return this.fallback.id;
  }

  async prefetch(start: CalendarDate, end: CalendarDate): Promise<void> {
    if (this.nbp === null || start > end) return;
    const earliest = addDays(end, -(this.nbp.maxDaysPerRequest - 1));
    const from = start > earliest ? start : earliest;
    this.requests += 1;
    try {
      this.tables = await this.nbp.tableRates(from, end);
    } catch (error) {
      if (error instanceof SourceException) {
        this.batchErrors.push(error.detail);
        this.log.info(`nbp table failed: ${error.detail}`);
      } else {
        // the fallback still answers
        this.batchErrors.push(reprError(error));
        this.log.warn("nbp table failed unexpectedly");
      }
      return;
    }
    this.window = [from, end];
  }

  async rates(quote: Currency, start: CalendarDate, end: CalendarDate): Promise<FxRate[]> {
    if (this.window !== null && this.window[0] <= start && end <= this.window[1]) {
      return (this.tables.get(quote) ?? []).filter((r) => start <= r.date && r.date <= end);
    }
    return this.fallback.rates(quote, start, end);
  }
}
