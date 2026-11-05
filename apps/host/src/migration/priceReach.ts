// After an import: the imported instruments the native valuation cannot price, through the same
// per-vault market read the app uses (`cachedInstrumentMarketData`), so `cashu migrate` and
// `cashu migrate verify` name them instead of the app silently valuing them at 0. Read only.
import { join } from "node:path";
import { toCurrency } from "@cashu/domain";
import { asInstrumentId, Currencies, instrument } from "@cashu/domain/investments";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import type { SqlDriver } from "@cashu/store";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { cachedInstrumentMarketData } from "../market/cachedData.js";
import { databaseName, readMigratedDeviceStore } from "./oneShot.js";

export interface UnpricedInstrument {
  /** The ticker, else the ISIN, else the instrument's name (public market identifiers). */
  readonly label: string;
  readonly currency: string;
  /** `no_prices`: no readable price history; `no_fx`: prices, but no PLN rate of its currency. */
  readonly reason: "no_prices" | "no_fx";
}

interface SourceInstrument {
  readonly id: number;
  readonly name: string;
  readonly symbol: string | null;
  readonly isin: string | null;
  readonly currency: string;
  readonly manual: number;
}

/** Every vault-mapped, market-valued instrument of the import whose prices the app cannot read. */
export function unpricedInstruments(device: SqlDriver, source: SqlDriver): UnpricedInstrument[] {
  const prices = new SqlPriceCache(device);
  const mapped = device
    .prepare(
      "SELECT instrument_id AS instrumentId,vault,gid FROM local_source_price_gids ORDER BY vault,instrument_id",
    )
    .all<{ instrumentId: number; vault: string; gid: string }>();
  const rows = new Map(
    source
      .prepare(
        `SELECT i.id,i.name,i.symbol,i.isin,i.currency,
           (i.valuation_mode='manual' OR EXISTS (SELECT 1 FROM inv_profile_instruments p
             WHERE p.instrument_id=i.id AND p.valuation_mode='manual')) AS manual
         FROM inv_instruments i`,
      )
      .all<SourceInstrument>()
      .map((row) => [row.id, row]),
  );
  const found = new Map<number, UnpricedInstrument>();
  for (const { instrumentId, vault, gid } of mapped) {
    const row = rows.get(instrumentId);
    if (row === undefined || row.manual || found.has(instrumentId)) continue;
    const currency = toCurrency(row.currency);
    const subject = instrument({
      id: asInstrumentId(gid),
      name: row.name,
      currency,
      assetClass: "equity",
    });
    const { data } = cachedInstrumentMarketData([subject], vault, prices);
    const reason =
      data.series(subject.id).length === 0
        ? "no_prices"
        : currency !== Currencies.PLN && data.fxRates(currency).length === 0
          ? "no_fx"
          : null;
    if (reason !== null)
      found.set(instrumentId, {
        label: row.symbol ?? row.isin ?? row.name,
        currency,
        reason,
      });
  }
  return [...found.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** `unpricedInstruments` of a migrated data dir: its device store and the Python backup's database. */
export function unpricedAfterMigration(dataDir: string, backupDir: string): UnpricedInstrument[] {
  const backup = join(dataDir, backupDir);
  const source = openNodeSqlite(join(backup, databaseName(backup)), { readOnly: true });
  try {
    return readMigratedDeviceStore(dataDir, (device) => unpricedInstruments(device, source));
  } finally {
    source.close();
  }
}
