/** Device-local public market cache. The caller owns the private driver and its lifecycle. */
import { D, type DateTime, parseDateTime, toStorage } from "@cashu/domain";
import {
  type CalendarDate,
  type Currency,
  type market,
  toCurrency,
} from "@cashu/domain/investments";
import { type MacroReport, reportStats } from "@cashu/domain/investments/macro";
import type { SourceCacheReceipt } from "../../genesis/verification/sourceCache.js";
import type { SqlDriver, SqlRow } from "../../sql/driver.js";

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

export interface SourcePriceIdentity {
  readonly instrumentId: number;
  readonly vault: string;
  readonly gid: string;
}
export interface SourcePriceAlias {
  readonly instrumentId: number;
  readonly provider: string;
  readonly symbol: string;
}
export interface SourceCachedBar extends market.CachedBar {
  readonly id: number;
  readonly source: string;
}
export interface SourceMacroBarView {
  readonly id: number;
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
      CREATE TABLE IF NOT EXISTS local_source_price_bars (
        id INTEGER PRIMARY KEY, instrument_id INTEGER NOT NULL, date TEXT NOT NULL,
        close TEXT NOT NULL, open TEXT, high TEXT, low TEXT, volume INTEGER, currency TEXT,
        source TEXT NOT NULL, fetched_at TEXT);
      CREATE TABLE IF NOT EXISTS local_source_price_aliases (
        instrument_id INTEGER NOT NULL, provider TEXT NOT NULL, symbol TEXT NOT NULL,
        PRIMARY KEY(instrument_id,provider,symbol));
      CREATE TABLE IF NOT EXISTS local_market_bar_masks (
        provider TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL,
        PRIMARY KEY(provider,symbol,date));
      CREATE INDEX IF NOT EXISTS local_source_price_alias_lookup
        ON local_source_price_aliases(provider,symbol);
      CREATE TABLE IF NOT EXISTS local_source_price_gids (
        instrument_id INTEGER NOT NULL, vault TEXT NOT NULL, gid TEXT NOT NULL,
        PRIMARY KEY(vault,instrument_id), UNIQUE(vault,gid));
      CREATE TABLE IF NOT EXISTS local_market_macro_bars (
        id INTEGER PRIMARY KEY, series TEXT NOT NULL, date TEXT NOT NULL,
        close TEXT NOT NULL, source TEXT NOT NULL, fetched_at TEXT);
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
    const native = this.driver
      .prepare("SELECT * FROM local_market_bars WHERE provider=? AND symbol=? ORDER BY date")
      .all<BarRow>(key.provider, key.symbol);
    const owners = this.driver
      .prepare(
        "SELECT instrument_id AS instrumentId FROM local_source_price_aliases WHERE provider=? AND symbol=? ORDER BY instrument_id",
      )
      .all<{ instrumentId: number }>(key.provider, key.symbol);
    const owner = owners.length === 1 ? owners[0] : undefined;
    const source =
      owner !== undefined
        ? this.driver
            .prepare(
              `SELECT b.* FROM local_source_price_bars b
               WHERE b.instrument_id=? AND b.source=?
               AND NOT EXISTS (SELECT 1 FROM local_market_bar_masks m
                 WHERE m.provider=? AND m.symbol=? AND m.date=b.date)
               ORDER BY b.date,b.id`,
            )
            .all<BarRow>(owner.instrumentId, key.provider, key.provider, key.symbol)
        : [];
    const merged = new Map<string, market.CachedBar>();
    for (const row of source) merged.set(row.date, cachedBar(row));
    for (const row of native) merged.set(row.date, cachedBar(row));
    return [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  /** Device-native public bars only; imported instrument rows require an exact vault identity. */
  nativeBars(key: market.MarketSymbol): readonly market.CachedBar[] {
    return this.driver
      .prepare("SELECT * FROM local_market_bars WHERE provider=? AND symbol=? ORDER BY date")
      .all<BarRow>(key.provider, key.symbol)
      .map(cachedBar);
  }

  /** Effective imported bars after a split refresh, scoped to one vault and canonical instrument. */
  effectiveBarsForInstrument(vault: string, gid: string): readonly SourceCachedBar[] {
    return this.driver
      .prepare(
        `SELECT b.* FROM local_source_price_bars b
         JOIN local_source_price_gids g ON g.instrument_id=b.instrument_id
         WHERE g.vault=? AND g.gid=?
           AND NOT EXISTS (
             SELECT 1 FROM local_source_price_aliases a
             JOIN local_market_bar_masks m ON m.provider=a.provider AND m.symbol=a.symbol
             WHERE a.instrument_id=b.instrument_id AND a.provider=b.source AND m.date=b.date
           )
         ORDER BY b.date,b.source,b.id`,
      )
      .all<BarRow & { id: number; source: string }>(vault, gid)
      .map((row) => ({ id: row.id, source: row.source, ...cachedBar(row) }));
  }

  /** Exact source rows by stable native instrument identity, including alias-less instruments. */
  barsForInstrument(vault: string, gid: string): readonly SourceCachedBar[] {
    return this.driver
      .prepare(
        `SELECT b.* FROM local_source_price_bars b
         JOIN local_source_price_gids g ON g.instrument_id=b.instrument_id
         WHERE g.vault=? AND g.gid=? ORDER BY b.date,b.source,b.id`,
      )
      .all<BarRow & { id: number; source: string }>(vault, gid)
      .map((row) => ({ id: row.id, source: row.source, ...cachedBar(row) }));
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
      const owners = this.driver
        .prepare(
          "SELECT instrument_id AS instrumentId FROM local_source_price_aliases WHERE provider=? AND symbol=? ORDER BY instrument_id",
        )
        .all<{ instrumentId: number }>(key.provider, key.symbol);
      const owner = owners.length === 1 ? owners[0] : undefined;
      if (owner !== undefined) {
        this.driver
          .prepare(
            `INSERT OR IGNORE INTO local_market_bar_masks(provider,symbol,date)
             SELECT ?,?,date FROM local_source_price_bars
             WHERE instrument_id=? AND source=? AND date>=? AND date<=?`,
          )
          .run(key.provider, key.symbol, owner.instrumentId, key.provider, from, to);
      }
      this.driver
        .prepare(
          "DELETE FROM local_market_bars WHERE provider=? AND symbol=? AND date>=? AND date<=?",
        )
        .run(key.provider, key.symbol, from, to);
    });
  }
  rates(provider: string, quote: Currency): readonly market.CachedRate[] {
    return this.ratesForBase(provider, "PLN", quote);
  }
  /** Exact imported FX base is retained; the normal PriceCache facade uses PLN. */
  ratesForBase(provider: string, base: string, quote: Currency): readonly market.CachedRate[] {
    return this.driver
      .prepare(
        "SELECT date,rate,fetched_at FROM local_market_rates WHERE provider=? AND base=? AND quote=? ORDER BY date",
      )
      .all<RateRow>(provider, base, quote)
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

  /** One-shot import of exact old cache rows, without invented fetch times or provider aliases. */
  restoreSourceCache(
    receipt: SourceCacheReceipt,
    identities: readonly SourcePriceIdentity[],
    aliases: readonly SourcePriceAlias[],
  ): void {
    this.write(() => {
      const price = this.driver.prepare(
        `INSERT INTO local_source_price_bars
         (id,instrument_id,date,close,open,high,low,volume,currency,source,fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const row of receipt.priceBars)
        price.run(
          row.id,
          row.instrumentId,
          row.date,
          row.close,
          row.open,
          row.high,
          row.low,
          row.volume,
          row.currency,
          row.source,
          row.fetchedAt,
        );
      const identity = this.driver.prepare(
        "INSERT INTO local_source_price_gids(instrument_id,vault,gid) VALUES (?,?,?)",
      );
      for (const row of identities) identity.run(row.instrumentId, row.vault, row.gid);
      const alias = this.driver.prepare(
        "INSERT INTO local_source_price_aliases(instrument_id,provider,symbol) VALUES (?,?,?)",
      );
      for (const row of aliases) alias.run(row.instrumentId, row.provider, row.symbol);
      const fx = this.driver.prepare(
        "INSERT INTO local_market_rates(id,provider,base,quote,date,rate,fetched_at) VALUES (?,?,?,?,?,?,?)",
      );
      for (const row of receipt.fxRates)
        fx.run(row.id, row.source, row.base, row.quote, row.date, row.rate, row.fetchedAt);
      const macro = this.driver.prepare(
        "INSERT INTO local_market_macro_bars(id,series,date,close,source,fetched_at) VALUES (?,?,?,?,?,?)",
      );
      for (const row of receipt.macroBars)
        macro.run(row.id, row.series, row.date, row.close, row.source, row.fetchedAt);
    });
  }

  /** Exact stored source rows for independent reopen/content verification. */
  sourceCacheRows(schema: string): SourceCacheReceipt {
    return {
      format: 1,
      schema,
      priceBars: this.driver
        .prepare(
          `SELECT id,instrument_id AS instrumentId,date,close,open,high,low,volume,currency,
                  source,fetched_at AS fetchedAt FROM local_source_price_bars ORDER BY id`,
        )
        .all<SourceCacheReceipt["priceBars"][number]>(),
      fxRates: this.driver
        .prepare(
          `SELECT id,base,quote,date,rate,provider AS source,fetched_at AS fetchedAt
           FROM local_market_rates ORDER BY id`,
        )
        .all<SourceCacheReceipt["fxRates"][number]>(),
      macroBars: this.driver
        .prepare(
          `SELECT id,series,date,close,source,fetched_at AS fetchedAt
           FROM local_market_macro_bars ORDER BY id`,
        )
        .all<SourceCacheReceipt["macroBars"][number]>(),
    };
  }

  sourceMappings(): {
    readonly identities: readonly SourcePriceIdentity[];
    readonly aliases: readonly SourcePriceAlias[];
  } {
    return {
      identities: this.driver
        .prepare(
          `SELECT instrument_id AS instrumentId,vault,gid
           FROM local_source_price_gids ORDER BY vault,instrument_id`,
        )
        .all<SourcePriceIdentity>(),
      aliases: this.driver
        .prepare(
          `SELECT instrument_id AS instrumentId,provider,symbol
           FROM local_source_price_aliases ORDER BY instrument_id,provider,symbol`,
        )
        .all<SourcePriceAlias>(),
    };
  }

  /** Fresh-import verification requires no cache writes that change effective imported bars. */
  importOverlayState(): {
    readonly bars: readonly SqlRow[];
    readonly masks: readonly SqlRow[];
  } {
    return {
      bars: this.driver
        .prepare("SELECT * FROM local_market_bars ORDER BY provider,symbol,date")
        .all(),
      masks: this.driver
        .prepare("SELECT * FROM local_market_bar_masks ORDER BY provider,symbol,date")
        .all(),
    };
  }

  /** Cached macro closes are available offline by series and provider. */
  macroBars(series: string, source?: string): readonly SourceMacroBarView[] {
    const imported = this.driver
      .prepare(
        `SELECT id,date,close,source,fetched_at AS fetchedAt FROM local_market_macro_bars
         WHERE series=? ${source === undefined ? "" : "AND source=?"} ORDER BY date,id`,
      )
      .all<{ id: number; date: string; close: string; source: string; fetchedAt: string | null }>(
        series,
        ...(source === undefined ? [] : [source]),
      )
      .map((row) => ({
        id: row.id,
        date: row.date,
        close: D(row.close),
        source: row.source,
        fetchedAt: row.fetchedAt === null ? null : parseDateTime(row.fetchedAt),
      }));
    const native = this.driver
      .prepare(`SELECT date,close,source,fetched_at AS fetchedAt FROM local_native_macro_bars
        WHERE series=? ${source === undefined ? "" : "AND source=?"} ORDER BY date`)
      .all<{ date: string; close: string; source: string; fetchedAt: string }>(
        series,
        ...(source === undefined ? [] : [source]),
      )
      .map((row) => ({
        id: 0,
        date: row.date,
        close: D(row.close),
        source: row.source,
        fetchedAt: parseDateTime(row.fetchedAt),
      }));
    const byDate = new Map(imported.map((row) => [row.date, row]));
    for (const row of native) byDate.set(row.date, row);
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
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
