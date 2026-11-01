// The investments.performance producer over the synthetic dataset and a synthetic strategy
// (invented values; the numbers are worked out by hand in the comments).

import { addDays, investments as inv } from "@cashu/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type PythonDb, withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { findProxy, producePerformance } from "./performance.ts";

import type { StrategyInputs, StrategyInputsByProfile } from "./strategy.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

type Tree = Record<string, unknown>;

const NO_STRATEGY: StrategyInputs = {
  state: "missing",
  benchmark: null,
  maxPriceAgeDays: 5,
  maxFxAgeDays: 10,
  contributions: null,
  strategy: null,
};

function strategiesFor(db: PythonDb, proxy: string): StrategyInputsByProfile {
  const equity = inv.bucketDef({
    id: "equity",
    match: inv.bucketMatch({ assetClasses: [inv.AssetClass.ETF] }),
  });
  return new Map([
    [
      db.keys.key("profiles", 1),
      {
        ...NO_STRATEGY,
        state: "valid",
        benchmark: { id: "test_bench", proxy },
        strategy: {
          baseCurrency: inv.Currencies.PLN,
          allocation: inv.allocationPlan({ buckets: [equity], targets: new Map([["equity", 1]]) }),
        },
      },
    ],
    [db.keys.key("profiles", 2), NO_STRATEGY],
  ]);
}

const run = <T>(fn: (db: PythonDb) => T): T =>
  withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, fn);

function produce(proxy: string): { out: Tree; p1: string; p2: string; keys: Tree } {
  return run((db) => ({
    out: JSON.parse(dumps(producePerformance(db, strategiesFor(db, proxy)))) as Tree,
    p1: db.keys.key("profiles", 1),
    p2: db.keys.key("profiles", 2),
    keys: {
      account1: db.keys.key("accounts", 1),
      account3: db.keys.key("accounts", 3),
      stock: db.keys.key("inv_instruments", 2),
    },
  }));
}

describe("investments performance producer", () => {
  it("finds the benchmark proxy by ISIN, then yahoo and stooq aliases in any case", () => {
    ds = syntheticDataset(INVESTMENTS);
    run((db) => {
      expect(findProxy(db, " pl0000000001 ")).toBe(1); // ISIN column, upper-cased
      expect(findProxy(db, "tstk")).toBe(2); // yahoo alias "TSTK" as the upper-case variant
      expect(findProxy(db, "TETF")).toBe(1); // stooq alias "tetf" as the lower-case variant
      expect(findProxy(db, "NOPE.DE")).toBeNull();
      expect(findProxy(db, " ")).toBeNull();
    });
  });

  it("writes every range and the max attribution per profile with natural keys", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { out, p1, keys } = produce("TSTK");
    const p = out[p1] as Tree;
    const views = p.performance as Record<string, Tree>;
    expect(Object.keys(views)).toEqual(["1m", "1y", "3m", "3y", "max", "ytd"]);
    const max = views.max as Tree;
    // the day before the first transaction (2026-01-02) to as_of: 274 days, sampled daily
    expect([max.start, max.end, max.step]).toEqual(["2026-01-01", "2026-10-01", "day"]);
    expect((max.points as Tree[]).length).toBe(274);
    // as_of: ETF 6 x 121.5 = 729, stock 2 x 60 USD x 3.9 = 468, manual 5 x 20 = 100, cash 4029
    expect((max.summary as Tree).end_value).toBe(5326.0);
    expect((max.summary as Tree).start_value).toBe(0.0);
    const [account] = max.accounts as [Tree];
    expect([account.account_id, account.name, account.currency]).toEqual([
      keys.account1,
      "Makler Test",
      "PLN",
    ]);
    // the proxy is the stock (yahoo TSTK): one bar, 2026-09-30, so prices only from then
    const bench = max.benchmark as Tree;
    expect([bench.status, bench.id, bench.instrument_id, bench.currency]).toEqual([
      "ok",
      "test_bench",
      keys.stock,
      "USD",
    ]);
    expect([bench.first_priced, bench.covers_range]).toEqual(["2026-09-30", false]);
    const notes = ((max.data_quality as Tree).notes as Tree[]).map((n) => n.code);
    expect(notes).toContain("benchmark_partial");
    const attribution = p.attribution_max as Tree;
    expect(attribution.grouping).toBe("strategy_buckets");
    expect((attribution.instruments as Tree[]).map((r) => r.bucket).sort()).toEqual([
      "equity",
      "unclassified",
      "unclassified",
    ]);
  });

  it("keeps profiles apart; no strategy means no benchmark and asset-class grouping", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { out, p2, keys } = produce("TSTK");
    const p = out[p2] as Tree;
    const max = (p.performance as Record<string, Tree>).max as Tree;
    expect((max.benchmark as Tree).status).toBe("no_strategy");
    expect((max.accounts as Tree[]).map((a) => a.account_id)).toEqual([keys.account3]);
    expect((p.attribution_max as Tree).grouping).toBe("asset_class");
  });

  it("reports an unresolved proxy", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { out, p1 } = produce("NOPE.DE");
    const max = ((out[p1] as Tree).performance as Record<string, Tree>).max as Tree;
    const bench = max.benchmark as Tree;
    expect([bench.status, bench.instrument_id, bench.simulation]).toEqual([
      "proxy_not_found",
      null,
      null,
    ]);
  });

  it("samples daily up to 400 days, weekly from the last day up to 1900, month ends beyond", () => {
    const dates = (n: number) => Array.from({ length: n }, (_, i) => addDays("2020-01-01", i));
    expect(inv.performance.sample(dates(401))[0]).toBe("day");
    const [step, picked] = inv.performance.sample(dates(402));
    expect(step).toBe("week");
    expect(picked.slice(0, 3)).toEqual([0, 2, 9]); // 401 - 2 = 399 = 7 x 57
    expect(picked[picked.length - 1]).toBe(401);
    const [monthly, ends] = inv.performance.sample(dates(1902));
    expect(monthly).toBe("month");
    expect(ends.slice(0, 2)).toEqual([0, 30]); // 2020-01-31
  });
});
