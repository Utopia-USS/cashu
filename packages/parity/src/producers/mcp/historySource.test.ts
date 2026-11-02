import { readFileSync } from "node:fs";
/** A public benchmark can exist in the copied catalog without belonging to the native vault. */
import { investments as inv } from "@cashu/domain";
import { investmentsPerformance, investmentsQueries } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { withPythonDb } from "../../sources/pythonDb.ts";
import { type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { nativeViewSources } from "../investments/viewSource.ts";
import { bindInvestmentHistory } from "./historySource.ts";

const fixture = JSON.parse(
  readFileSync(new URL("../investments/fixtures/review-views.json", import.meta.url), "utf8"),
) as { sql: string; files: Record<string, string> };
let dataset: SyntheticDataset | undefined;
afterEach(() => dataset?.dispose());
const GLOBAL_PROXY = `
INSERT INTO inv_instruments (id,name,currency,asset_class,symbol,isin,mic,region,sector,tags,needs_classification,valuation_mode,status,created_at,updated_at) VALUES (77777,'Synthetic global reference','EUR','etf','REF',NULL,'XETR',NULL,NULL,'[]',0,'market','active','2026-01-01 00:00:00.000000','2026-01-01 00:00:00.000000');
INSERT INTO inv_instrument_aliases (id,instrument_id,namespace,value,guessed,created_at) VALUES (77777,77777,'yahoo','REF.DE',0,'2026-01-01 00:00:00.000000');
WITH RECURSIVE days(day,n) AS (SELECT '2020-01-01',0 UNION ALL SELECT date(day,'+1 day'),n+1 FROM days WHERE day<'2026-10-01')
INSERT INTO inv_price_bars (id,instrument_id,date,close,open,high,low,volume,currency,source,fetched_at) SELECT 100000+n,77777,day,CAST(100+n AS TEXT),NULL,NULL,NULL,NULL,'EUR','yahoo',NULL FROM days;
WITH RECURSIVE days(day,n) AS (SELECT '2020-01-01',0 UNION ALL SELECT date(day,'+1 day'),n+1 FROM days WHERE day<'2026-10-01')
INSERT OR REPLACE INTO inv_fx_rates (id,base,quote,date,rate,source,fetched_at) SELECT 100000+n,'PLN','EUR',day,'4.3','nbp',NULL FROM days;
`;
it("augments actual copied global benchmark facts without changing vault ownership or portfolio inputs", () => {
  dataset = syntheticDataset(fixture.sql + GLOBAL_PROXY);
  for (const [path, text] of Object.entries(fixture.files)) dataset.writeFile(path, text);
  dataset.writeFile(
    "profiles/synthetic-view-1/strategy.yaml",
    `version: 1
base_currency: PLN
benchmark: { id: msci_acwi, proxy: REF.DE }
`,
  );
  withPythonDb({ dataset: "demo", sourceDir: dataset.dir, runRoot: dataset.runRoot }, (db) => {
    const source = nativeViewSources(db).find((row) => row.profile.id === 1);
    if (source === undefined) throw new Error("missing synthetic source");
    const read = source.vault.store.read.bind(source.vault.store),
      config = source.strategy.config;
    if (config === null) throw new Error("missing synthetic strategy");
    const strategy = {
      state: source.strategy.state,
      benchmark: config.benchmark,
      policy: {
        maxPriceAgeDays: config.data.maxPriceAgeDays,
        maxFxAgeDays: config.data.maxFxAgeDays,
      },
      strategy: { baseCurrency: config.baseCurrency, allocation: config.allocation },
    };
    const native = investmentsPerformance.performanceInputs(read, {
      marketData: source.marketData,
      asOf: db.asOf,
      strategy,
    });
    const ownedBefore = investmentsQueries.vaultInstrumentGids(read);
    expect(native.benchmarkInstrument).toBeNull();
    expect(
      inv.performance.historyMetrics(inv.performance.computePerformance(native, db.asOf))
        ?.benchmark,
    ).toBeNull();
    const history = bindInvestmentHistory(db, 1).performance();
    expect(history?.benchmarkMeta.status).toBe("ok");
    expect(history?.benchmark?.coversRange).toBe(true);
    expect(history?.benchmark?.coversRangeEnd).toBe(true);
    expect(history?.benchmark?.twr).not.toBeNull();
    expect(history?.benchmark?.simulationMwr).not.toBeNull();
    expect(history?.perYear.some((year) => year.benchmark !== null)).toBe(true);
    expect(investmentsQueries.vaultInstrumentGids(read)).toEqual(ownedBefore);
    expect(investmentsQueries.instrumentByAlias(read, "yahoo", "REF.DE")).toBeUndefined();
    const after = investmentsPerformance.performanceInputs(read, {
      marketData: source.marketData,
      asOf: db.asOf,
      strategy,
    });
    expect(after).toEqual(native);
  });
});
