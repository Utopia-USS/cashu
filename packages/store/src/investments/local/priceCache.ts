/**
 * Device-local public market cache. The caller owns the driver and its lifecycle: a cache over a driver
 * of its own (the phone's market.db) is closed with `close()`; one over a shared driver (the host's
 * device store) is never closed by the cache.
 */
import { D, type DateTime, parseDateTime, toStorage } from "@cashu/domain";
import {
  type CalendarDate,
  type Currency,
  type market,
  toCurrency,
} from "@cashu/domain/investments";
import { type MacroReport, reportStats } from "@cashu/domain/investments/macro";
import type { SqlDriver } from "../../sql/driver.js";

interface BarRow {
  date: string;
  close: string;
  open: string | null;
  high: string | null;
  low: string | null;
  volume: number | null;
  currency: string | null;
  fetched_at: string | null;
}
interface RateRow {
  date: string;
  rate: string;
  fetched_at: string | null;
}
const decimal = (value: string | null) => (value === null ? null : D(value));
const cachedBar = (row: BarRow): market.CachedBar => ({
  date: row.date as CalendarDate,
  close: D(row.close),
  open: decimal(row.open),
  high: decimal(row.high),
  low: decimal(row.low),
  volume: row.volume,
  currency: row.currency === null ? null : toCurrency(row.currency),
  fetchedAt: row.fetched_at === null ? null : parseDateTime(row.fetched_at),
});

export interface MacroBarView {
  readonly date: string;
  readonly close: ReturnType<typeof D>;
  readonly source: string;
  readonly fetchedAt: DateTime | null;
}

/** Independent schema: never registered as a synchronized financial projection or DeviceStore table. */
export interface TransactionalPriceCache extends market.PriceCache {
  batch<T>(work: () => T): T;
}
export class SqlPriceCache implements TransactionalPriceCache {
  private readonly driver: SqlDriver;
  private batchDepth = 0;
  private readonly listeners = new Set<() => void>();
  constructor(driver: SqlDriver) {
    this.driver = driver;
    driver.transaction(() =>
      driver.exec(`
      CREATE TABLE IF NOT EXISTS local_market_meta (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, schema_version INTEGER NOT NULL);
      INSERT OR IGNORE INTO local_market_meta VALUES (1,0,1);
      CREATE TABLE IF NOT EXISTS local_market_bars (
        provider TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL, close TEXT NOT NULL,
        open TEXT, high TEXT, low TEXT, volume INTEGER, currency TEXT, fetched_at TEXT,
        PRIMARY KEY(provider,symbol,date));
      CREATE TABLE IF NOT EXISTS local_market_rates (
        id INTEGER PRIMARY KEY, provider TEXT NOT NULL, base TEXT NOT NULL, quote TEXT NOT NULL,
        date TEXT NOT NULL, rate TEXT NOT NULL, fetched_at TEXT,
        UNIQUE(provider,base,quote,date));
      CREATE TABLE IF NOT EXISTS local_native_macro_bars (
        series TEXT NOT NULL, date TEXT NOT NULL, close TEXT NOT NULL,
        source TEXT NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY(series,date));
    `),
    );
    if (
      driver
        .prepare("SELECT schema_version FROM local_market_meta WHERE id=1")
        .get<{ schema_version: number }>()?.schema_version !== 1
    )
      throw new Error("unsupported market cache schema");
  }
  version(): number {
    const row = this.driver
      .prepare("SELECT version FROM local_market_meta WHERE id=1")
      .get<{ version: number }>();
    if (row === undefined) throw new Error("missing market cache version");
    return row.version;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Drop the subscribers and close the driver (only for a cache that was given a driver of its own). */
  close(): void {
    this.listeners.clear();
    this.driver.close();
  }
  batch<T>(work: () => T): T {
    const before = this.version();
    this.batchDepth++;
    let committed = false;
    try {
      const result = this.driver.transaction(work);
      committed = true;
      return result;
    } finally {
      this.batchDepth--;
      if (committed && this.batchDepth === 0 && this.version() !== before) this.notify();
    }
  }
  private write(fn: () => void): void {
    this.driver.transaction(() => {
      fn();
      if (this.version() >= Number.MAX_SAFE_INTEGER)
        throw new Error("market cache version exhausted");
      this.driver.prepare("UPDATE local_market_meta SET version=version+1 WHERE id=1").run();
    });
    if (this.batchDepth === 0) this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* Observers cannot undo committed writes or trigger a retry. */
      }
    }
  }
  bars(key: market.MarketSymbol): readonly market.CachedBar[] {
    return this.driver
      .prepare("SELECT * FROM local_market_bars WHERE provider=? AND symbol=? ORDER BY date")
      .all<BarRow>(key.provider, key.symbol)
      .map(cachedBar);
  }

  upsertBars(key: market.MarketSymbol, bars: readonly market.CachedBar[], now: DateTime): void {
    this.write(() => {
      const stmt = this.driver.prepare(`INSERT INTO local_market_bars VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider,symbol,date) DO UPDATE SET close=excluded.close,
        open=COALESCE(excluded.open,open),high=COALESCE(excluded.high,high),low=COALESCE(excluded.low,low),
        volume=COALESCE(excluded.volume,volume),currency=excluded.currency,fetched_at=excluded.fetched_at`);
      for (const b of bars)
        stmt.run(
          key.provider,
          key.symbol,
          b.date,
          b.close.toString(),
          b.open?.toString() ?? null,
          b.high?.toString() ?? null,
          b.low?.toString() ?? null,
          b.volume,
          b.currency,
          toStorage(b.fetchedAt ?? now),
        );
    });
  }
  deleteBars(key: market.MarketSymbol, from: CalendarDate, to: CalendarDate): void {
    this.write(() => {
      this.driver
        .prepare(
          "DELETE FROM local_market_bars WHERE provider=? AND symbol=? AND date>=? AND date<=?",
        )
        .run(key.provider, key.symbol, from, to);
    });
  }
  rates(provider: string, quote: Currency): readonly market.CachedRate[] {
    return this.driver
      .prepare(
        "SELECT date,rate,fetched_at FROM local_market_rates WHERE provider=? AND base='PLN' AND quote=? ORDER BY date",
      )
      .all<RateRow>(provider, quote)
      .map((r) => ({
        date: r.date as CalendarDate,
        rate: D(r.rate),
        fetchedAt: r.fetched_at === null ? null : parseDateTime(r.fetched_at),
      }));
  }
  upsertRates(
    provider: string,
    quote: Currency,
    rates: readonly market.CachedRate[],
    now: DateTime,
  ): void {
    this.write(() => {
      const stmt = this.driver.prepare(`INSERT INTO local_market_rates
        (provider,base,quote,date,rate,fetched_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(provider,base,quote,date) DO UPDATE SET rate=excluded.rate,fetched_at=excluded.fetched_at`);
      for (const r of rates)
        stmt.run(provider, "PLN", quote, r.date, r.rate.toString(), toStorage(r.fetchedAt ?? now));
    });
  }
  newestFxDate(provider = "nbp"): CalendarDate | null {
    return (
      this.driver
        .prepare("SELECT MAX(date) AS date FROM local_market_rates WHERE provider=? AND base='PLN'")
        .get<{ date: string | null }>(provider)?.date ?? null
    );
  }

  /** Cached macro closes are available offline by series and provider. */
  macroBars(series: string, source?: string): readonly MacroBarView[] {
    return this.driver
      .prepare(`SELECT date,close,source,fetched_at AS fetchedAt FROM local_native_macro_bars
        WHERE series=? ${source === undefined ? "" : "AND source=?"} ORDER BY date`)
      .all<{ date: string; close: string; source: string; fetchedAt: string }>(
        series,
        ...(source === undefined ? [] : [source]),
      )
      .map((row) => ({
        date: row.date,
        close: D(row.close),
        source: row.source,
        fetchedAt: parseDateTime(row.fetchedAt),
      }));
  }

  applyMacroReport(report: MacroReport, now: DateTime) {
    this.write(() => {
      const erase = this.driver.prepare(
        "DELETE FROM local_native_macro_bars WHERE series=? AND date>=? AND date<=?",
      );
      const put = this.driver.prepare(
        "INSERT INTO local_native_macro_bars(series,date,close,source,fetched_at) VALUES (?,?,?,?,?)",
      );
      for (const item of report.series) {
        if (
          item.status !== "ok" ||
          item.start === null ||
          item.end === null ||
          item.source === null
        )
          continue;
        erase.run(item.series, item.start, item.end);
        for (const [date, close] of item.closes)
          put.run(item.series, date, close.toString(), item.source, toStorage(now));
      }
    });
    return reportStats(report);
  }
}
