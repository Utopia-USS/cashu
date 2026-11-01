// The investments.valuation / investments.allocation producers over a synthetic dataset and a
// synthetic strategy (invented values; the numbers are worked out by hand in the comments).

import { investments as inv } from "@cashu/domain";
import { afterEach, describe, expect, it } from "vitest";
import { type PythonDb, withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceAllocation, produceValuation } from "./portfolio.ts";
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

function strategiesFor(db: PythonDb): StrategyInputsByProfile {
  const equity = inv.bucketDef({
    id: "equity",
    match: inv.bucketMatch({ assetClasses: [inv.AssetClass.ETF] }),
  });
  const cash = inv.bucketDef({
    id: "cash",
    match: inv.bucketMatch({ assetClasses: [inv.AssetClass.CASH] }),
  });
  return new Map([
    [
      db.keys.key("profiles", 1),
      {
        ...NO_STRATEGY,
        strategy: {
          baseCurrency: inv.Currencies.PLN,
          allocation: inv.allocationPlan({
            buckets: [equity, cash],
            targets: new Map([
              ["equity", 0.5],
              ["cash", 0.25],
              ["bonds", 0.25],
            ]),
          }),
        },
      },
    ],
    [db.keys.key("profiles", 2), NO_STRATEGY],
  ]);
}

function produce(): { valuation: Tree; allocation: Tree; p1: string; p2: string; keys: Tree } {
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
    const strategies = strategiesFor(db);
    return {
      valuation: JSON.parse(dumps(produceValuation(db, strategies))) as Tree,
      allocation: JSON.parse(dumps(produceAllocation(db, strategies))) as Tree,
      p1: db.keys.key("profiles", 1),
      p2: db.keys.key("profiles", 2),
      keys: {
        account1: db.keys.key("accounts", 1),
        account3: db.keys.key("accounts", 3),
        etf: db.keys.key("inv_instruments", 1),
        old: db.keys.key("inv_instruments", 3),
        sell: db.keys.key("inv_transactions", 4),
      },
    };
  });
}

describe("investments portfolio producers", () => {
  it("value holdings and cash in the base currency with natural keys", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { valuation, p1, keys } = produce();
    const p = valuation[p1] as Tree;
    const valued = p.valued as Tree;
    // ETF 6 x 121.5 = 729.0, stock 2 x 60 USD x 3.9 = 468.0, manual 5 x 20 = 100, cash 4029
    expect(valued.total_base).toBe("5326.0");
    expect(valued.cash_base).toBe("4029");
    const rows = valued.valued as Tree[];
    expect(rows.map((r) => r.market_value_base)).toEqual(["729.0", "468.0", "100"]);
    // USD cost: unit cost 50.5000000000 (10 places) x 2 at the 2026-02-04 rate 4.0
    expect(rows[1]?.cost_basis_base).toBe("404.00000000000");
    const etf = rows[0] as Tree;
    expect((etf.holding as Tree).account_id).toBe(keys.account1);
    expect((etf.instrument as Tree).id).toBe(keys.etf);
    // the profile's override: its tags, "" clears the region, the plan with an aware timestamp
    expect((etf.instrument as Tree).tags).toEqual(["equity", "core"]);
    expect((etf.instrument as Tree).plan_at).toBe("2026-09-01T10:00:00.000001+00:00");
    expect(typeof etf.weight).toBe("number");
    // FIFO sell of 4 of 10: cost 1005 x 4 / 10, proceeds 440 - 2
    const realized = (p.snapshot as Tree).realized as Tree[];
    expect(realized.map((t) => [t.close_txn_id, t.pnl])).toEqual([[keys.sell, "36.0000000000"]]);
    // last trade prices keep the app's ids as keys, as canon.py does
    expect(Object.keys((p.snapshot as Tree).last_trade_prices as Tree).sort()).toEqual(["1", "2"]);
  });

  it("keeps profiles apart and writes warnings as their Python dataclass fields", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { valuation, p2, keys } = produce();
    const p = valuation[p2] as Tree;
    const valued = p.valued as Tree;
    // the rename moved the lot to the manual instrument, valued with this profile's 99
    const [row] = valued.valued as [Tree];
    expect((row.instrument as Tree).id).toBe(keys.old);
    expect(row.market_value_base).toBe("99");
    expect(valued.total_base).toBe("99");
    // cash -100: a history gap, counted as 0; no `kind`, `account_id` as a natural key
    expect((p.snapshot as Tree).warnings).toEqual([
      { account_id: keys.account3, amount: "-100", as_of: "2026-10-01", currency: "PLN" },
    ]);
  });

  it("allocates to the strategy's buckets; no strategy gives null", () => {
    ds = syntheticDataset(INVESTMENTS);
    const { allocation, p1, p2 } = produce();
    expect((allocation[p2] as Tree).allocation).toBeNull();
    const a = (allocation[p1] as Tree).allocation as Tree;
    const buckets = a.allocations as Tree[];
    expect(buckets.map((b) => [b.bucket_id, b.value_base])).toEqual([
      ["equity", "729.0"],
      ["cash", "4029"],
      ["bonds", "0"],
    ]);
    // stock and the manual instrument match no bucket
    expect(a.unclassified_value_base).toBe("568.0");
    // bonds: weight 0, target 0.25 -> drift -0.25 (25 pp under), 0 - 0.25 x 5326.0 to buy
    expect(buckets[2]?.drift_pp).toBe(-25.0);
    expect(buckets[2]?.drift_value_base).toBe("-1331.500");
  });
});
