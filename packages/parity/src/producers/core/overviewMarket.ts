/** Genuine copied market facts behind the symbol-keyed native overview port, never oracle outputs. */
import { D, parseDateTime } from "@cashu/domain";
import { market, toCurrency } from "@cashu/domain/investments";
import type { PythonDb } from "../../sources/index.ts";
import { genesisRun } from "../store/genesisRun.ts";

const copies = new WeakMap<PythonDb, market.PriceCache>();

export function copiedOverviewPrices(db: PythonDb): market.PriceCache {
  const found = copies.get(db);
  if (found !== undefined) return found;
  const ids = [
    ...new Set(
      [...genesisRun(db).vaults.values()].flatMap((vault) =>
        [...vault.sources.values()]
          .filter((row) => row.table === "inv_instruments")
          .map((row) => Number(row.localId)),
      ),
    ),
  ];
  const aliases = db.investments
    .aliases(ids)
    .filter((row) => row.namespace === "yahoo" || row.namespace === "stooq");
  const cache = new market.InMemoryPriceCache();
  const now = parseDateTime(`${db.asOf}T12:00:00Z`);
  for (const bar of db.investments.priceBars(ids)) {
    for (const alias of aliases) {
      if (
        alias.instrumentId !== bar.instrumentId ||
        (bar.source !== "demo" && alias.namespace !== bar.source)
      )
        continue;
      // The original synthetic DemoSource supplies these same bars behind its Yahoo/Stooq aliases,
      // as in the isolated Electron acceptance loader. No prices/symbols/ownership are invented.
      cache.upsertBars(
        market.marketSymbol(alias.namespace, alias.value),
        [
          {
            date: bar.date,
            close: D(bar.close),
            open: bar.open === null ? null : D(bar.open),
            high: bar.high === null ? null : D(bar.high),
            low: bar.low === null ? null : D(bar.low),
            volume: bar.volume,
            currency: bar.currency === null ? null : toCurrency(bar.currency),
            fetchedAt: bar.fetchedAt === null ? null : parseDateTime(bar.fetchedAt),
          },
        ],
        now,
      );
    }
  }
  for (const rate of db.investments.fxRates()) {
    if (rate.base !== "PLN") continue;
    cache.upsertRates(
      rate.source === "demo" ? "nbp" : rate.source,
      toCurrency(rate.quote),
      [
        {
          date: rate.date,
          rate: D(rate.rate),
          fetchedAt: rate.fetchedAt === null ? null : parseDateTime(rate.fetchedAt),
        },
      ],
      now,
    );
  }
  copies.set(db, cache);
  return cache;
}
