/**
 * Test-for-test translation of `tests/investments/portfolio/test_inv_allocation.py` (allocation, port
 * of allocation_test.dart incl. R1 unclassified share and R2 cash history gap). Synthetic data only.
 * Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import {
  type AllocationPlan,
  allocationPlan,
  type BucketDef,
  bucketDef,
  bucketMatch,
} from "../domain/buckets.js";
import { AssetClass } from "../domain/enums.js";
import { instrument as makeInstrument } from "../domain/instrument.js";
import {
  allocationOf,
  type BucketAllocation,
  type CashBalance,
  marketView as makeMarketView,
  unclassifiedWeight,
  valuedCash,
  valuedPortfolio,
} from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import { asProfileId } from "../domain/values.js";
import { InMemoryFxLookup } from "./fxLookup.js";
import {
  allocate,
  buildSnapshot,
  matchesBucket,
  matchesCashBucket,
  valuePortfolio,
} from "./index.js";
import {
  acc,
  bar,
  buy,
  cashTxn,
  d,
  EUR,
  fxRate,
  instrument,
  marketView,
  newId,
  PLN,
  USD,
} from "./testing/fixtures.js";

// Python `Decimal ==` compares by value (`Decimal("100") == Decimal("100.00")`).
expect.addEqualityTesters([
  (a: unknown, b: unknown) => (a instanceof Decimal && b instanceof Decimal ? a.eq(b) : undefined),
]);

const PROFILE = asProfileId(newId());
const ACC = acc(newId());
const IKE = acc(newId());
const VWCE = instrument(null, {
  name: "World ETF",
  symbol: "VWCE",
  mic: "XETR",
  assetClass: AssetClass.ETF,
  tags: ["global_equity", "accumulating"],
});
const PKN = instrument(); // Orlen, XWAR equity
const AAPL = instrument(null, { name: "Apple", symbol: "AAPL", mic: "XNAS", currency: USD });
const BOND = instrument(null, {
  name: "EDO bond",
  symbol: "EDO",
  mic: null,
  assetClass: AssetClass.TREASURY_BOND,
});
const GOLD = instrument(null, {
  name: "Gold ETC",
  symbol: "GLD",
  mic: "XETR",
  assetClass: AssetClass.COMMODITY,
});
const MONEY_MARKET = instrument(null, {
  name: "Money market",
  symbol: "MM",
  mic: null,
  assetClass: AssetClass.CASH,
});
const AS_OF = "2026-03-10";
const FX = new InMemoryFxLookup([fxRate(USD, "2026-03-10", "4.00")]);

const MARKET = marketView(AS_OF, {
  instruments: [VWCE, PKN, AAPL, BOND, GOLD, MONEY_MARKET],
  bars: [
    ...[VWCE, PKN, BOND, GOLD, MONEY_MARKET].map((i) => bar(i.id, AS_OF, "100")),
    bar(AAPL.id, AS_OF, "25"), // 25 USD x 4.00 = 100 PLN
  ],
});

function valuePortfolioOf(txns: Transaction[]) {
  const snapshot = buildSnapshot(PROFILE, txns, AS_OF, { profileAccounts: new Set([ACC, IKE]) });
  return valuePortfolio(snapshot, MARKET, FX, PLN, 5);
}

function bucket(
  bucketId: string,
  assetClasses: Iterable<AssetClass> = [],
  mics: Iterable<string> = [],
): BucketDef {
  return bucketDef({ id: bucketId, match: bucketMatch({ assetClasses, mics }) });
}

// The ARCHITECTURE example plan.
const PLAN: AllocationPlan = allocationPlan({
  buckets: [
    bucketDef({
      id: "global_equity",
      match: bucketMatch({ assetClasses: [AssetClass.ETF], tags: ["global_equity"] }),
    }),
    bucket("pl_equity", [AssetClass.EQUITY], ["XWAR"]),
    bucket("bonds", [AssetClass.BOND, AssetClass.TREASURY_BOND]),
    bucket("cash", [AssetClass.CASH]),
  ],
  targets: { global_equity: 0.6, pl_equity: 0.15, bonds: 0.2, cash: 0.05 },
});

// VWCE 3000, PKN 500, bond 1000, gold 250 (unclassified), cash 250: total 5000.
const EXAMPLE_PORTFOLIO = (): Transaction[] => [
  cashTxn(ACC, "2026-01-02", "5000"),
  buy(ACC, VWCE.id, "2026-01-05", "30", "100"),
  buy(ACC, PKN.id, "2026-01-05", "5", "100"),
  buy(ACC, BOND.id, "2026-01-05", "10", "100"),
  buy(ACC, GOLD.id, "2026-01-05", "2.5", "100"),
];

const byBucketId = (allocations: readonly BucketAllocation[]) =>
  new Map(allocations.map((a) => [a.bucketId, a] as const));

const must = <T>(value: T | null | undefined): T => {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
  return value as T;
};

describe("allocate", () => {
  // test_weights_drift_and_drift_values_unclassified_holdings_dilute_the_buckets
  it("weights, drift and drift values; unclassified holdings dilute the buckets", () => {
    const result = allocate(valuePortfolioOf(EXAMPLE_PORTFOLIO()), PLAN);

    expect(result.totalBase).toEqual(d("5000"));
    expect(result.allocations.map((a) => a.bucketId)).toEqual([
      "global_equity",
      "pl_equity",
      "bonds",
      "cash",
    ]);
    const byId = byBucketId(result.allocations);

    const pl = must(byId.get("pl_equity"));
    expect(pl.valueBase).toEqual(d("500"));
    expect(pl.weight).toBeCloseTo(0.1, 7);
    expect(pl.target).toBe(0.15);
    expect(pl.driftPp).toBeCloseTo(-5, 5);
    expect(pl.driftRel).toBeCloseTo(-1 / 3, 7);
    expect(pl.driftValueBase).toEqual(d("-250")); // 500 - 0.15 x 5000

    const globalEquity = must(byId.get("global_equity"));
    expect([globalEquity.valueBase, globalEquity.driftValueBase]).toEqual([d("3000"), d("0")]);
    expect(globalEquity.weight).toBeCloseTo(0.6, 7);
    expect(globalEquity.driftPp).toBeCloseTo(0, 9);

    expect(must(byId.get("bonds")).valueBase).toEqual(d("1000"));
    expect(must(byId.get("cash")).valueBase).toEqual(d("250"));
    expect(must(byId.get("cash")).weight).toBeCloseTo(0.05, 7);

    expect(result.unclassified).toHaveLength(1);
    const [unclassified] = result.unclassified;
    expect(must(unclassified).instrument).toEqual(GOLD);
    expect(result.unclassifiedValueBase).toEqual(d("250"));
    expect(unclassifiedWeight(result)).toBeCloseTo(0.05, 7); // R1: rules skip above the limit
    expect(result.unallocatedCashBase).toEqual(d("0"));
    expect(result.allocations.reduce((s, a) => s + a.weight, 0)).toBeCloseTo(0.95, 6);
    expect(result.holdingsByBucket.get("global_equity")?.map((h) => h.instrument)).toEqual([VWCE]);
    expect(result.holdingsByBucket.has("cash")).toBe(false); // cash is not a holding
    expect(allocationOf(result, "bonds")).toBe(byId.get("bonds"));
    expect(allocationOf(result, "nope")).toBeNull();
  });

  // test_untagged_imported_etf_is_unclassified_r1
  it("untagged imported ETF is unclassified (R1)", () => {
    const imported = instrument(null, {
      name: "Vanguard FTSE All-World",
      symbol: "VWRL",
      mic: "XAMS",
      assetClass: AssetClass.ETF,
      needsClassification: true,
    });
    const market = makeMarketView({
      ...MARKET,
      instruments: new Map([...MARKET.instruments, [imported.id, imported]]),
      bars: new Map([...MARKET.bars, [imported.id, [bar(imported.id, AS_OF, "100")]]]),
    });
    const snapshot = buildSnapshot(
      PROFILE,
      [cashTxn(ACC, "2026-01-02", "10000"), buy(ACC, imported.id, "2026-01-05", "90", "100")],
      AS_OF,
    );
    const result = allocate(valuePortfolio(snapshot, market, FX, PLN, 5), PLAN);
    // 9000 of 10000 sit in no bucket: global_equity looks 60 pp underweight unless rules check this.
    expect(unclassifiedWeight(result)).toBeCloseTo(0.9, 7);
    expect(must(allocationOf(result, "global_equity")).weight).toBe(0.0);
  });

  // test_the_first_matching_bucket_in_declaration_order_wins
  it("the first matching bucket in declaration order wins", () => {
    const portfolio = valuePortfolioOf([
      buy(ACC, PKN.id, "2026-01-05", "1", "100"),
      buy(ACC, AAPL.id, "2026-01-05", "4", "25", { currency: USD }),
    ]);
    const specificFirst = allocationPlan({
      buckets: [
        bucket("pl_equity", [AssetClass.EQUITY], ["XWAR"]),
        bucket("equity", [AssetClass.EQUITY]),
      ],
      targets: { pl_equity: 0.5, equity: 0.5 },
    });
    const generalFirst = allocationPlan({
      buckets: [...specificFirst.buckets].reverse(),
      targets: specificFirst.targets,
    });

    const specific = allocate(portfolio, specificFirst);
    expect(specific.holdingsByBucket.get("pl_equity")?.map((h) => h.instrument)).toEqual([PKN]);
    expect(specific.holdingsByBucket.get("equity")?.map((h) => h.instrument)).toEqual([AAPL]);
    expect(specific.allocations.map((a) => a.valueBase)).toEqual([d("100"), d("400")]);

    const general = allocate(portfolio, generalFirst);
    expect(general.holdingsByBucket.get("equity")?.map((h) => h.instrument)).toEqual([PKN, AAPL]);
    expect(general.holdingsByBucket.has("pl_equity")).toBe(false);
    expect(general.allocations.map((a) => [a.bucketId, a.valueBase])).toEqual([
      ["equity", d("500")],
      ["pl_equity", d("0")],
    ]);
  });

  // test_raw_cash_goes_to_the_first_bucket_matching_cash_in_its_currency
  it("raw cash goes to the first bucket matching cash in its currency", () => {
    const portfolio = valuePortfolioOf([
      cashTxn(ACC, "2026-01-02", "350"),
      cashTxn(IKE, "2026-01-02", "100", { currency: USD }), // 400 PLN
      buy(ACC, PKN.id, "2026-01-05", "1", "100"),
      buy(ACC, MONEY_MARKET.id, "2026-01-05", "1", "100"),
    ]);

    const catchAllLast = allocate(
      portfolio,
      allocationPlan({
        buckets: [bucket("cash", [AssetClass.CASH]), bucket("everything")],
        targets: { cash: 0.1, everything: 0.9 },
      }),
    );
    // The money-market fund (asset class cash) is matched like any instrument.
    expect(catchAllLast.allocations.map((a) => [a.bucketId, a.valueBase])).toEqual([
      ["cash", d("650")], // 150 PLN + 400 PLN from USD + the 100 PLN money-market fund
      ["everything", d("100")],
    ]);
    expect(catchAllLast.totalBase).toEqual(d("750"));

    // A catch-all matches cash too; declared first it takes everything (the loader warns about that).
    const catchAllFirst = allocate(
      portfolio,
      allocationPlan({
        buckets: [bucket("everything"), bucket("cash", [AssetClass.CASH])],
        targets: { everything: 0.9, cash: 0.1 },
      }),
    );
    expect(catchAllFirst.allocations.map((a) => a.valueBase)).toEqual([d("750"), d("0")]);

    const byCurrency = allocate(
      portfolio,
      allocationPlan({
        buckets: [
          bucket("stocks", [AssetClass.EQUITY]),
          bucketDef({
            id: "pln_cash",
            match: bucketMatch({ assetClasses: [AssetClass.CASH], currencies: [PLN] }),
          }),
          bucketDef({
            id: "usd_cash",
            match: bucketMatch({ assetClasses: [AssetClass.CASH], currencies: [USD] }),
          }),
        ],
        targets: { stocks: 0.5, pln_cash: 0.25, usd_cash: 0.25 },
      }),
    );
    expect(byCurrency.allocations.map((a) => [a.bucketId, a.valueBase])).toEqual([
      ["stocks", d("100")],
      ["pln_cash", d("250")], // 150 raw PLN cash + the PLN money-market fund
      ["usd_cash", d("400")],
    ]);

    const noCashBucket = allocate(
      portfolio,
      allocationPlan({
        buckets: [bucket("stocks", [AssetClass.EQUITY])],
        targets: { stocks: 1.0 },
      }),
    );
    expect(noCashBucket.unallocatedCashBase).toEqual(d("550"));
    expect(noCashBucket.unclassified.map((h) => h.instrument)).toEqual([MONEY_MARKET]);
    expect(noCashBucket.totalBase).toEqual(d("750"));
    expect(must(noCashBucket.allocations[0]).weight).toBeCloseTo(100 / 750, 7);
  });

  // test_bucket_without_target_target_without_bucket_and_duplicate_bucket_ids
  it("bucket without target, target without bucket and duplicate bucket ids", () => {
    const result = allocate(
      valuePortfolioOf([
        cashTxn(ACC, "2026-01-02", "2000"),
        buy(ACC, PKN.id, "2026-01-05", "10", "100"),
        buy(ACC, VWCE.id, "2026-01-05", "10", "100"),
      ]),
      allocationPlan({
        buckets: [
          bucket("pl", [AssetClass.EQUITY]),
          bucket("pl", [AssetClass.ETF]), // duplicate id: one bucket, an alternative match
          bucket("empty", [AssetClass.CRYPTO]),
        ],
        targets: { pl: 0.5, bonds: 0.5 },
      }),
    );

    expect(result.allocations.map((a) => a.bucketId)).toEqual(["pl", "empty", "bonds"]);
    const [pl, empty, bonds] = result.allocations.map((a) => must(a));
    expect([pl?.valueBase, pl?.weight, pl?.driftRel, pl?.driftValueBase]).toEqual([
      d("2000"),
      1.0,
      1.0,
      d("1000"),
    ]);
    expect([empty?.target, empty?.weight, empty?.driftRel]).toEqual([0.0, 0.0, 0.0]);
    expect([bonds?.valueBase, bonds?.driftRel, bonds?.driftValueBase]).toEqual([
      d("0"),
      -1.0,
      d("-1000"),
    ]);
    expect(result.unclassified).toEqual([]);

    const overweightUntargeted = allocate(
      valuePortfolioOf([
        cashTxn(ACC, "2026-01-02", "100"),
        buy(ACC, PKN.id, "2026-01-05", "1", "100"),
      ]),
      allocationPlan({ buckets: [bucket("pl", [AssetClass.EQUITY])], targets: {} }),
    );
    expect(overweightUntargeted.allocations).toHaveLength(1);
    const only = must(overweightUntargeted.allocations[0]);
    expect(only.driftRel).toBe(Number.POSITIVE_INFINITY);
    expect(only.driftValueBase).toEqual(d("100"));
  });

  // test_negative_cash_counts_as_zero_and_flags_its_bucket_r2
  it("negative cash counts as zero and flags its bucket (R2)", () => {
    const valued = valuePortfolioOf([
      cashTxn(ACC, "2026-01-02", "1000"),
      buy(ACC, PKN.id, "2026-01-05", "30", "100"), // 3000 PLN: 2000 of deposits are missing
      cashTxn(IKE, "2026-01-02", "500"),
    ]);
    expect(valued.cash.map((c) => c.amountBase)).toEqual([d("-2000"), d("500")]);
    const result = allocate(valued, PLAN);
    expect(result.totalBase).toEqual(d("3500")); // PKN 3000 + IKE cash 500; the negative balance is 0
    const cash = must(allocationOf(result, "cash"));
    expect([cash.valueBase, cash.cashHistoryGap]).toEqual([d("500"), true]);
    expect(result.allocations.filter((a) => a.cashHistoryGap).map((a) => a.bucketId)).toEqual([
      "cash",
    ]);
  });

  // test_holdings_without_a_price_are_classified_but_add_no_value
  it("holdings without a price are classified but add no value", () => {
    const unpriced = instrument(null, { name: "Unpriced", symbol: "UNP" });
    const view = marketView(AS_OF, {
      instruments: [PKN, unpriced],
      bars: [bar(PKN.id, AS_OF, "100")],
    });
    const portfolio = valuePortfolio(
      buildSnapshot(
        PROFILE,
        [
          cashTxn(ACC, "2026-01-02", "200"),
          buy(ACC, PKN.id, "2026-01-05", "1", "100"),
          buy(ACC, unpriced.id, "2026-01-05", "1", "100"),
        ],
        AS_OF,
      ),
      view,
      FX,
      PLN,
      5,
      { lastKnownPrices: new Map() }, // no fallback to the trade price
    );

    const result = allocate(
      portfolio,
      allocationPlan({ buckets: [bucket("equity", [AssetClass.EQUITY])], targets: { equity: 1 } }),
    );

    expect(result.holdingsByBucket.get("equity")).toHaveLength(2);
    expect(must(result.allocations[0]).valueBase).toEqual(d("100"));
    // cash is 0 after both buys; only the priced holding counts
    expect(result.totalBase).toEqual(d("100"));
  });

  // test_the_account_filter_allocates_only_the_given_accounts
  it("the account filter allocates only the given accounts", () => {
    const portfolio = valuePortfolioOf([
      cashTxn(ACC, "2026-01-02", "1000"),
      cashTxn(IKE, "2026-01-02", "400"),
      buy(ACC, PKN.id, "2026-01-05", "10", "100"),
      buy(IKE, VWCE.id, "2026-01-05", "3", "100"),
    ]);

    const result = allocate(portfolio, PLAN, { accountIds: new Set([IKE]) });

    expect(result.totalBase).toEqual(d("400"));
    const byId = byBucketId(result.allocations);
    expect(must(byId.get("global_equity")).weight).toBeCloseTo(0.75, 7);
    expect(must(byId.get("cash")).valueBase).toEqual(d("100"));
    expect(must(byId.get("pl_equity")).valueBase).toEqual(d("0"));
    expect(allocate(portfolio, PLAN).totalBase).toEqual(d("1400"));
  });

  // test_a_hand_built_portfolio_allocates_its_listed_cash_filtered_by_account
  it("a hand-built portfolio allocates its listed cash filtered by account", () => {
    const snapshot = buildSnapshot(
      PROFILE,
      [cashTxn(ACC, "2026-01-02", "300"), cashTxn(IKE, "2026-01-02", "50", { currency: USD })],
      AS_OF,
    );
    const handBuilt = valuedPortfolio({
      snapshot,
      baseCurrency: PLN,
      cash: [
        valuedCash({ cash: snapshot.cash[0] as CashBalance, amountBase: d("300") }),
        valuedCash({ cash: snapshot.cash[1] as CashBalance, amountBase: d("200") }), // 50 USD x 4.00
      ],
      cashBase: d("500"),
      totalBase: d("500"),
      staleWeight: 0,
    });
    const cashOnly = allocationPlan({
      buckets: [bucket("cash", [AssetClass.CASH])],
      targets: { cash: 1 },
    });

    expect(must(allocate(handBuilt, cashOnly).allocations[0]).valueBase).toEqual(d("500"));
    expect(
      must(allocate(handBuilt, cashOnly, { accountIds: new Set([ACC]) }).allocations[0]).valueBase,
    ).toEqual(d("300"));
    expect(
      must(allocate(handBuilt, cashOnly, { accountIds: new Set([IKE]) }).allocations[0]).valueBase,
    ).toEqual(d("200"));
  });
});

// --- matches_bucket -----------------------------------------------------------------------------

const TAGGED = instrument(null, {
  symbol: "IWDA",
  mic: "xams",
  currency: EUR,
  assetClass: AssetClass.ETF,
  tags: ["Global_Equity", "accumulating", "developed"],
});

describe("matchesBucket", () => {
  // test_an_empty_match_accepts_every_instrument
  it("an empty match accepts every instrument", () => {
    expect(matchesBucket(bucketMatch(), TAGGED)).toBe(true);
    expect(matchesBucket(bucketMatch(), PKN)).toBe(true);
  });

  // test_a_set_criterion_matches_any_of_its_elements
  it("a set criterion matches any of its elements", () => {
    const bonds = bucketMatch({ assetClasses: [AssetClass.BOND, AssetClass.TREASURY_BOND] });
    expect(matchesBucket(bonds, BOND)).toBe(true);
    expect(matchesBucket(bonds, PKN)).toBe(false);
    expect(matchesBucket(bucketMatch({ mics: ["XWAR", "XAMS"] }), TAGGED)).toBe(true); // case-insensitive
    expect(matchesBucket(bucketMatch({ mics: ["XWAR"] }), BOND)).toBe(false); // no mic
    expect(matchesBucket(bucketMatch({ currencies: [USD, EUR] }), TAGGED)).toBe(true);
    expect(matchesBucket(bucketMatch({ currencies: [USD] }), PKN)).toBe(false);
    expect(matchesBucket(bucketMatch({ instrumentIds: [PKN.id, BOND.id] }), PKN)).toBe(true);
    expect(matchesBucket(bucketMatch({ instrumentIds: [BOND.id] }), PKN)).toBe(false);
  });

  // test_tags_must_all_be_present_case_insensitive
  it("tags must all be present, case-insensitive", () => {
    expect(matchesBucket(bucketMatch({ tags: ["global_equity", "accumulating"] }), TAGGED)).toBe(
      true,
    );
    expect(matchesBucket(bucketMatch({ tags: ["global_equity", "distributing"] }), TAGGED)).toBe(
      false,
    );
    expect(matchesBucket(bucketMatch({ tags: ["global_equity"] }), PKN)).toBe(false);
  });

  // test_every_set_criterion_must_hold
  it("every set criterion must hold", () => {
    const etfWithTag = bucketMatch({ assetClasses: [AssetClass.ETF], tags: ["global_equity"] });
    expect(matchesBucket(etfWithTag, TAGGED)).toBe(true);
    expect(matchesBucket(etfWithTag, VWCE)).toBe(true);
    expect(matchesBucket(etfWithTag, GOLD)).toBe(false); // wrong asset class
    expect(matchesBucket(etfWithTag, makeInstrument({ ...TAGGED, tags: ["developed"] }))).toBe(
      false,
    );
    expect(
      matchesBucket(etfWithTag, makeInstrument({ ...TAGGED, assetClass: AssetClass.FUND })),
    ).toBe(false);
    const plEquity = bucketMatch({
      assetClasses: [AssetClass.EQUITY],
      mics: ["XWAR"],
      currencies: [PLN],
    });
    expect(matchesBucket(plEquity, PKN)).toBe(true);
    expect(matchesBucket(plEquity, AAPL)).toBe(false);
  });

  // test_raw_cash_matches_buckets_taking_cash_and_no_instrument_only_criteria
  it("raw cash matches buckets taking cash and no instrument-only criteria", () => {
    expect(matchesCashBucket(bucketMatch({ assetClasses: [AssetClass.CASH] }), USD)).toBe(true);
    expect(matchesCashBucket(bucketMatch(), PLN)).toBe(true);
    expect(matchesCashBucket(bucketMatch({ assetClasses: [AssetClass.ETF] }), PLN)).toBe(false);
    expect(matchesCashBucket(bucketMatch({ currencies: [PLN] }), PLN)).toBe(true);
    expect(
      matchesCashBucket(bucketMatch({ assetClasses: [AssetClass.CASH], tags: ["x"] }), PLN),
    ).toBe(false);
    expect(
      matchesCashBucket(bucketMatch({ assetClasses: [AssetClass.CASH], currencies: [PLN] }), USD),
    ).toBe(false);
  });
});
