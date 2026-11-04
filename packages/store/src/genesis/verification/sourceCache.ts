import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "../../canonical.js";
import type { SqlDriver } from "../../sql/driver.js";

type Raw = Readonly<Record<string, unknown>>;
const MAX_ROWS = 2_000_000;
const MAX_BYTES = 256 * 1024 * 1024;

export class SourceCacheError extends Error {
  constructor() {
    super("source_cache_mismatch");
    this.name = "SourceCacheError";
  }
}

export interface SourcePriceBar {
  readonly id: number;
  readonly instrumentId: number;
  readonly date: string;
  readonly close: string;
  readonly open: string | null;
  readonly high: string | null;
  readonly low: string | null;
  readonly volume: number | null;
  readonly currency: string | null;
  readonly source: string;
  readonly fetchedAt: string | null;
}

export interface SourceFxRate {
  readonly id: number;
  readonly base: string;
  readonly quote: string;
  readonly date: string;
  readonly rate: string;
  readonly source: string;
  readonly fetchedAt: string | null;
}

export interface SourceMacroBar {
  readonly id: number;
  readonly series: string;
  readonly date: string;
  readonly close: string;
  readonly source: string;
  readonly fetchedAt: string | null;
}

/** Private canonical plaintext, never a status/render payload. */
export interface SourceCacheReceipt {
  readonly format: 1;
  readonly schema: string;
  readonly priceBars: readonly SourcePriceBar[];
  readonly fxRates: readonly SourceFxRate[];
  readonly macroBars: readonly SourceMacroBar[];
}

export interface SourceCacheProof {
  readonly format: 1;
  readonly digest: string;
  readonly bytes: number;
  readonly priceBars: number;
  readonly fxRates: number;
  readonly macroBars: number;
  /** Keep this only in private import memory until the device cache is hydrated. */
  readonly receipt: SourceCacheReceipt;
}

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new SourceCacheError();
  }
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new SourceCacheError();
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === null) return null;
  return string(value);
}

function optionalInteger(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new SourceCacheError();
  return value;
}

function exactColumns(driver: SqlDriver, table: string, expected: readonly string[]): void {
  const actual = driver
    .prepare(`PRAGMA table_info("${table}")`)
    .all<{ name: string }>()
    .map((row) => row.name);
  const set = new Set(expected);
  if (actual.length !== set.size || actual.some((name) => !set.has(name))) {
    throw new SourceCacheError();
  }
}

export function assertSourceCacheSchema(driver: SqlDriver): void {
  exactColumns(driver, "inv_price_bars", [
    "id",
    "instrument_id",
    "date",
    "close",
    "open",
    "high",
    "low",
    "volume",
    "currency",
    "source",
    "fetched_at",
  ]);
  exactColumns(driver, "inv_fx_rates", [
    "id",
    "base",
    "quote",
    "date",
    "rate",
    "source",
    "fetched_at",
  ]);
  exactColumns(driver, "inv_macro_bars", ["id", "series", "date", "close", "source", "fetched_at"]);
}

function boundedCount(driver: SqlDriver, table: string): number {
  const n = driver.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get<{ n: number }>()?.n;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > MAX_ROWS) {
    throw new SourceCacheError();
  }
  return n;
}

function encode(receipt: SourceCacheReceipt): { digest: string; bytes: number } {
  const bytes = new TextEncoder().encode(canonicalJson(receipt));
  if (bytes.length > MAX_BYTES) throw new SourceCacheError();
  return { digest: bytesToHex(sha256(bytes)), bytes: bytes.length };
}

/**
 * Lossless source-side receipt for all three Python market tables. It retains every provider,
 * base, raw decimal string, nullable fetch time and numeric source instrument ID. It does not
 * claim that the current native SqlPriceCache can serve every row offline.
 */
export function captureSourceCacheReceipt(driver: SqlDriver, schema: string): SourceCacheProof {
  const actualSchema = driver
    .prepare("SELECT version_num FROM alembic_version")
    .get<{ version_num: string }>()?.version_num;
  if (actualSchema !== schema) throw new SourceCacheError();
  assertSourceCacheSchema(driver);
  const counts = {
    priceBars: boundedCount(driver, "inv_price_bars"),
    fxRates: boundedCount(driver, "inv_fx_rates"),
    macroBars: boundedCount(driver, "inv_macro_bars"),
  };
  if (counts.priceBars + counts.fxRates + counts.macroBars > MAX_ROWS) throw new SourceCacheError();
  const priceBars = driver
    .prepare("SELECT * FROM inv_price_bars ORDER BY id")
    .all<Raw>()
    .map(
      (row): SourcePriceBar => ({
        id: positiveId(row.id),
        instrumentId: positiveId(row.instrument_id),
        date: string(row.date),
        close: string(row.close),
        open: optionalString(row.open),
        high: optionalString(row.high),
        low: optionalString(row.low),
        volume: optionalInteger(row.volume),
        currency: optionalString(row.currency),
        source: string(row.source),
        fetchedAt: optionalString(row.fetched_at),
      }),
    );
  const fxRates = driver
    .prepare("SELECT * FROM inv_fx_rates ORDER BY id")
    .all<Raw>()
    .map(
      (row): SourceFxRate => ({
        id: positiveId(row.id),
        base: string(row.base),
        quote: string(row.quote),
        date: string(row.date),
        rate: string(row.rate),
        source: string(row.source),
        fetchedAt: optionalString(row.fetched_at),
      }),
    );
  const macroBars = driver
    .prepare("SELECT * FROM inv_macro_bars ORDER BY id")
    .all<Raw>()
    .map(
      (row): SourceMacroBar => ({
        id: positiveId(row.id),
        series: string(row.series),
        date: string(row.date),
        close: string(row.close),
        source: string(row.source),
        fetchedAt: optionalString(row.fetched_at),
      }),
    );
  if (
    priceBars.length !== counts.priceBars ||
    fxRates.length !== counts.fxRates ||
    macroBars.length !== counts.macroBars
  )
    throw new SourceCacheError();
  const receipt: SourceCacheReceipt = { format: 1, schema, priceBars, fxRates, macroBars };
  const encoded = encode(receipt);
  return { format: 1, ...encoded, ...counts, receipt };
}

/** Independent read of the frozen SQLite source versus the conversion's private receipt. */
export function verifySourceCacheReceipt(driver: SqlDriver, expected: SourceCacheProof): void {
  if (expected.format !== 1) throw new SourceCacheError();
  const claimed = encode(expected.receipt);
  const actual = captureSourceCacheReceipt(driver, expected.receipt.schema);
  if (
    claimed.digest !== expected.digest ||
    claimed.bytes !== expected.bytes ||
    actual.digest !== expected.digest ||
    actual.bytes !== expected.bytes ||
    actual.priceBars !== expected.priceBars ||
    actual.fxRates !== expected.fxRates ||
    actual.macroBars !== expected.macroBars
  )
    throw new SourceCacheError();
}
