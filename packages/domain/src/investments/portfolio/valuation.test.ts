/**
 * Test-for-test translation of `tests/investments/portfolio/test_inv_valuation.py` (valuation incl.
 * R2/R4/R12/R14/R15, plus manual and frozen valuation). Synthetic data only. Each `it` names its
 * Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { type Decimal, decimalKey } from "../../decimal.js";
import { AssetClass, InstrumentStatus, ValuationMode } from "../domain/enums.js";
import { fetchesMarketData, sameInstrument } from "../domain/instrument.js";
import {
  countedBase,
  holdingAverageCost,
  holdingHasUnknownCost,
  portfolioRealizedPnlBase,
  realizedCost,
  realizedPnlBase,
  realizedPnlByCurrency,
  realizedProceeds,
  type ValuedHolding,
  valuedAtCost,
  valuedManually,
} from "../domain/snapshot.js";
import type { Transaction } from "../domain/transaction.js";
import { asProfileId } from "../domain/values.js";
import {
  frozenValuedAtZero,
  lastKnownPriceUsed,
  missingCostBasis,
  missingFxRate,
  missingInstrument,
  missingManualValuation,
  missingPrice,
  type PortfolioWarning,
  realizedCurrencyMismatch,
  staleFxRate,
  stalePrice,
  warningKey,
} from "../domain/warnings.js";
import { buildSnapshot, InMemoryFxLookup, lastTradePrices, valuePortfolio } from "./index.js";
import {
  acc,
  bar,
  buy,
  cashTxn,
  d,
  EUR,
  fxRate,
  instrument,
  manual,
  marketView,
  newId,
  PLN,
  sell,
  transferIn,
  USD,
} from "./testing/fixtures.js";

/** Decimal compared by value (Python `==`); null stays null. */
const k = (value: Decimal | null | undefined): string | null =>
  value == null ? null : decimalKey(value);

/** Warnings compared by value (Python dataclass `==`). */
const ws = (warnings: readonly PortfolioWarning[]): string[] => warnings.map(warningKey);

function three(valued: readonly ValuedHolding[]): [ValuedHolding, ValuedHolding, ValuedHolding] {
  expect(valued).toHaveLength(3);
  return valued as [ValuedHolding, ValuedHolding, ValuedHolding];
}

function two(valued: readonly ValuedHolding[]): [ValuedHolding, ValuedHolding] {
  expect(valued).toHaveLength(2);
  return valued as [ValuedHolding, ValuedHolding];
}

function one(valued: readonly ValuedHolding[]): ValuedHolding {
  expect(valued).toHaveLength(1);
  return valued[0] as ValuedHolding;
}

const PROFILE = asProfileId(newId());
const ACC = acc(newId());
const IKE = acc(newId());
const PL_STOCK = instrument(); // Orlen, PKN, XWAR, PLN equity
const USD_ETF = instrument(null, {
  name: "World ETF",
  symbol: "VT",
  mic: "ARCX",
  currency: USD,
  assetClass: AssetClass.ETF,
});
const STALE = instrument(null, { name: "Small cap", symbol: "SML" });
const FUND = instrument(null, {
  name: "Bond fund",
  symbol: null,
  mic: null,
  assetClass: AssetClass.FUND,
});
const AS_OF = "2026-03-10";

// NBP-style rates (PLN per unit). 2026-01-02 is a Friday, 2026-01-04 a Sunday.
const FX = new InMemoryFxLookup([
  fxRate(USD, "2026-01-02", "3.90"),
  fxRate(USD, "2026-01-05", "4.00"),
  fxRate(USD, "2026-03-10", "4.20"),
  fxRate(EUR, "2026-01-05", "5.00"),
  fxRate(EUR, "2026-03-10", "4.00"),
]);

function snapshotOf(txns: readonly Transaction[], at: string = AS_OF) {
  return buildSnapshot(PROFILE, txns, at, { profileAccounts: new Set([ACC, IKE]) });
}

// Hand-computed: A 10 x 120 = 1200; B 5 x 110 USD x 4.20 = 2310; C (stale) 4 x 50 = 200;
// cash 870 PLN + 100 USD x 4.20 = 1290; total 5000.
const TXNS = [
  cashTxn(ACC, "2026-01-02", "2110"),
  cashTxn(ACC, "2026-01-02", "600", { currency: USD }),
  buy(ACC, PL_STOCK.id, "2026-01-05", "10", "100"), // cost 1000
  buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", { currency: USD }), // 500 USD x 4.00 = 2000
  buy(ACC, STALE.id, "2026-01-05", "4", "60"), // cost 240
];
const MARKET = marketView(AS_OF, {
  instruments: [PL_STOCK, USD_ETF, STALE],
  bars: [
    bar(PL_STOCK.id, "2026-03-06", "118"),
    bar(PL_STOCK.id, "2026-03-09", "120"),
    bar(USD_ETF.id, "2026-03-10", "110"),
    bar(STALE.id, "2026-02-20", "50"),
  ],
});

describe("valuation", () => {
  // test_market_value_cost_basis_cash_weights_and_stale_weight
  it("market value, cost basis, cash, weights and stale weight", () => {
    const valued = valuePortfolio(snapshotOf(TXNS), MARKET, FX, PLN, 5);

    expect(valued.baseCurrency).toBe(PLN);
    expect(valued.snapshot.asOf).toBe(AS_OF);
    expect(k(valued.cashBase)).toBe(k(d("1290")));
    expect(k(valued.totalBase)).toBe(k(d("5000")));
    expect(valued.staleWeight).toBeCloseTo(0.04, 6);

    const [a, b, c] = three(valued.valued);
    expect(sameInstrument(a.instrument, PL_STOCK)).toBe(true);
    expect([k(a.price), a.priceDate, a.isStale]).toEqual([k(d("120")), "2026-03-09", false]);
    expect([k(a.marketValueBase), k(a.costBasisBase)]).toEqual([k(d("1200")), k(d("1000"))]);
    expect(a.unrealizedPct).toBeCloseTo(0.2, 6);
    expect(a.weight).toBeCloseTo(0.24, 6);
    expect([a.valuationMode, valuedAtCost(a), valuedManually(a)]).toEqual([
      ValuationMode.MARKET,
      false,
      false,
    ]);

    expect([k(b.price), b.isStale]).toEqual([k(d("110")), false]);
    expect([k(b.marketValueBase), k(b.costBasisBase)]).toEqual([k(d("2310")), k(d("2000"))]);
    expect(b.unrealizedPct).toBeCloseTo(0.155, 6);
    expect(b.weight).toBeCloseTo(0.462, 6);

    expect([k(c.price), c.priceDate, c.isStale]).toEqual([k(d("50")), "2026-02-20", true]);
    expect([k(c.marketValueBase), k(c.costBasisBase)]).toEqual([k(d("200")), k(d("240"))]);
    expect(c.unrealizedPct).toBeCloseTo(-1 / 6, 6);
    expect(c.weight).toBeCloseTo(0.04, 6);

    expect(ws(valued.warnings)).toEqual(
      ws([stalePrice({ instrumentId: STALE.id, priceDate: "2026-02-20", ageDays: 18 })]),
    );
    expect(valued.cash.map((cash) => [cash.cash.currency, k(cash.amountBase)])).toEqual([
      [PLN, k(d("870"))],
      [USD, k(d("420"))],
    ]);
  });

  // test_cost_basis_uses_the_rate_on_or_before_each_lot_date
  it("cost basis uses the rate on or before each lot date", () => {
    const valued = valuePortfolio(
      snapshotOf([
        buy(ACC, USD_ETF.id, "2026-01-04", "1", "100", { currency: USD }), // 100 x 3.90 (Friday)
        buy(ACC, USD_ETF.id, "2026-01-05", "1", "100", { currency: USD }), // 100 x 4.00
      ]),
      MARKET,
      FX,
      PLN,
      5,
    );
    const holding = one(valued.valued);
    expect(k(holding.costBasisBase)).toBe(k(d("790")));
    expect(k(holding.marketValueBase)).toBe(k(d("924"))); // 2 x 110 x 4.20
  });

  // test_a_price_is_stale_only_when_older_than_max_price_age_days
  it("a price is stale only when older than max price age days", () => {
    const snapshot = snapshotOf([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")]);

    const valueWithBarOn = (on: string): ValuedHolding => {
      const view = marketView(AS_OF, {
        instruments: [PL_STOCK],
        bars: [bar(PL_STOCK.id, on, "100")],
      });
      return valuePortfolio(snapshot, view, FX, PLN, 5).valued[0] as ValuedHolding;
    };

    expect(valueWithBarOn("2026-03-05").isStale).toBe(false); // 5 days
    expect(valueWithBarOn("2026-03-04").isStale).toBe(true); // 6 days
    // still valued and weighted
    expect(k(valueWithBarOn("2026-03-04").marketValueBase)).toBe(k(d("100")));
  });

  // test_bars_after_the_snapshot_date_are_ignored
  it("bars after the snapshot date are ignored", () => {
    const valued = valuePortfolio(
      snapshotOf([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")]),
      marketView("2026-03-20", {
        instruments: [PL_STOCK],
        bars: [bar(PL_STOCK.id, "2026-03-09", "120"), bar(PL_STOCK.id, "2026-03-11", "999")],
      }),
      FX,
      PLN,
      5,
    );
    expect(k((valued.valued[0] as ValuedHolding).price)).toBe(k(d("120")));
  });

  // test_a_missing_price_excludes_the_holding_from_totals_and_weights
  it("a missing price excludes the holding from totals and weights", () => {
    const allBars = [...MARKET.bars.values()].flat();
    const valued = valuePortfolio(
      snapshotOf([...TXNS, buy(ACC, FUND.id, "2026-01-05", "10", "25")]),
      marketView(AS_OF, { instruments: [PL_STOCK, USD_ETF, STALE, FUND], bars: allBars }),
      FX,
      PLN,
      5,
      { lastKnownPrices: new Map() }, // no fallback: the fund has no price at all
    );
    const missing = valued.valued[valued.valued.length - 1] as ValuedHolding;
    expect(missing.holding.instrumentId).toBe(FUND.id);
    expect([missing.price, missing.priceDate, missing.marketValueBase, missing.weight]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(missing.isStale).toBe(true);
    expect(k(missing.costBasisBase)).toBe(k(d("250")));
    expect(k(valued.cashBase)).toBe(k(d("1040"))); // the fund purchase left 250 PLN less cash
    expect(k(valued.totalBase)).toBe(k(d("4750")));
    expect(ws(valued.warnings)).toContain(
      warningKey(missingPrice({ instrumentId: FUND.id, asOf: AS_OF })),
    );
  });

  // test_without_bars_the_last_known_price_is_used_and_flagged_stale
  it("without bars the last known price is used and flagged stale", () => {
    const fundTxns = [
      cashTxn(ACC, "2026-01-02", "550"),
      buy(ACC, FUND.id, "2026-01-05", "10", "25"),
      buy(ACC, FUND.id, "2026-02-15", "10", "30"),
    ];
    const snapshot = snapshotOf(fundTxns);
    const view = marketView(AS_OF, { instruments: [FUND] });

    expect(
      [...snapshot.lastTradePrices].map(([id, p]) => [id, p.date, k(p.price), p.currency]),
    ).toEqual([[FUND.id, "2026-02-15", k(d("30")), PLN]]);
    const valued = valuePortfolio(snapshot, view, FX, PLN, 5);
    const explicit = valuePortfolio(snapshot, view, FX, PLN, 5, {
      lastKnownPrices: lastTradePrices(fundTxns),
    });
    expect(explicit).toEqual(valued);

    const holding = one(valued.valued);
    expect([k(holding.price), holding.priceDate, holding.isStale]).toEqual([
      k(d("30")),
      "2026-02-15",
      true,
    ]);
    expect(k(holding.marketValueBase)).toBe(k(d("600")));
    expect(valued.staleWeight).toBe(1.0); // cash is 0, the fund is the whole portfolio
    expect(ws(valued.warnings)).toEqual(
      ws([lastKnownPriceUsed({ instrumentId: FUND.id, priceDate: "2026-02-15", price: d("30") })]),
    );

    // A "last known" price dated after the snapshot is not used.
    const future = new Map([[FUND.id, { date: "2026-04-01", price: d("31"), currency: PLN }]]);
    const none = valuePortfolio(snapshot, view, FX, PLN, 5, { lastKnownPrices: future });
    expect((none.valued[0] as ValuedHolding).marketValueBase).toBeNull();
    expect(ws(none.warnings)).toEqual(ws([missingPrice({ instrumentId: FUND.id, asOf: AS_OF })]));
  });

  // test_instruments_valued_at_cost_use_the_cost_basis_and_are_never_stale
  it("instruments valued at cost use the cost basis and are never stale", () => {
    const bond = instrument(null, {
      name: "EDO0536",
      symbol: "EDO0536",
      mic: null,
      assetClass: AssetClass.TREASURY_BOND,
    });
    const usdBond = instrument(null, {
      name: "US T-Bill",
      symbol: null,
      mic: null,
      currency: USD,
      assetClass: AssetClass.BOND,
      valuationMode: ValuationMode.COST,
    });
    const unknown = instrument(null, {
      name: "COI",
      symbol: null,
      mic: null,
      assetClass: AssetClass.TREASURY_BOND,
    });
    expect(bond.valuationMode).toBe(ValuationMode.COST);
    expect(PL_STOCK.valuationMode).toBe(ValuationMode.MARKET);
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "1500"),
      buy(ACC, bond.id, "2026-01-05", "10", "100"), // cost 1000 PLN
      buy(ACC, bond.id, "2026-02-02", "5", "100"), // cost 500 PLN
      buy(ACC, usdBond.id, "2026-01-05", "1", "100", { currency: USD }), // 100 USD x 4.00 = 400
      transferIn(ACC, unknown.id, "2026-01-05", "3"), // unknown cost
    ]);
    // A stray bar of a cost-valued instrument is ignored.
    const view = marketView(AS_OF, {
      instruments: [bond, usdBond, unknown],
      bars: [bar(bond.id, "2026-01-10", "90")],
    });

    const valued = valuePortfolio(snapshot, view, FX, PLN, 5);

    const [b, u, x] = three(valued.valued);
    expect([k(b.marketValueBase), k(b.costBasisBase), k(b.price), b.priceDate]).toEqual([
      k(d("1500")),
      k(d("1500")),
      k(d("100")),
      null,
    ]);
    expect([b.isStale, valuedAtCost(b), b.unrealizedPct]).toEqual([false, true, 0.0]);
    expect([k(u.marketValueBase), u.isStale, valuedAtCost(u)]).toEqual([k(d("400")), false, true]);
    expect([k(x.marketValueBase), k(x.price), x.isStale, valuedAtCost(x), x.weight]).toEqual([
      null,
      null,
      true,
      true,
      null,
    ]);
    // Cash 1500 - 1500 PLN = 0, -100 USD x 4.20 = -420 counted as 0 (cash history gap, R2);
    // total 1500 + 400 = 1900.
    expect(valued.cash.map((c) => [k(c.amountBase), k(countedBase(c))])).toEqual([
      [k(d("-420")), k(d("0"))],
    ]);
    expect(k(valued.totalBase)).toBe(k(d("1900")));
    expect(valued.staleWeight).toBe(0);
    expect(ws(valued.warnings)).toEqual(
      ws([missingCostBasis({ accountId: ACC, instrumentId: unknown.id })]),
    );
    expect((valued.warnings[0] as PortfolioWarning).accountId).toBe(ACC);
  });

  // test_missing_fx_rates_leave_the_amounts_out_with_warnings_r4
  it("missing fx rates leave the amounts out with warnings (R4)", () => {
    const noUsd = new InMemoryFxLookup([]);
    const valued = valuePortfolio(
      snapshotOf([
        cashTxn(ACC, "2026-01-02", "100", { currency: USD }),
        cashTxn(ACC, "2026-01-02", "100"),
        buy(ACC, USD_ETF.id, "2026-01-05", "1", "50", { currency: USD }),
        buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100"),
      ]),
      MARKET,
      noUsd,
      PLN,
      5,
    );
    const [etf, stock] = two(valued.valued);
    expect(k(etf.price)).toBe(k(d("110")));
    expect([k(etf.marketValueBase), k(etf.costBasisBase), etf.weight, etf.unrealizedPct]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(stock.weight).toBe(1.0); // PLN cash is 0, USD cash cannot be converted
    expect(k(valued.cashBase)).toBe(k(d("0")));
    expect(valued.cash).toHaveLength(1);
    const usdCash = valued.cash[0] as (typeof valued.cash)[number];
    expect(usdCash.amountBase).toBeNull();
    expect(k(usdCash.cash.amount)).toBe(k(d("50")));
    expect(ws(valued.warnings)).toEqual(
      ws([
        missingFxRate({ currency: USD, base: PLN, date: AS_OF }),
        missingFxRate({ currency: USD, base: PLN, date: "2026-01-05" }),
      ]),
    );
    // The gap is visible on the holding and the portfolio, so weight rules can skip.
    expect([etf.missingFxCurrency, etf.priceCurrency]).toEqual([USD, USD]);
    expect(stock.missingFxCurrency).toBeNull();
    expect(valued.missingFxCurrencies).toEqual(new Set([USD]));
  });

  // test_an_fx_rate_older_than_max_fx_age_days_counts_as_missing_r14
  it("an fx rate older than max fx age days counts as missing (R14)", () => {
    // The newest USD rate is from 2026-02-20, 18 days before as_of; cost basis rates are fresh.
    const oldUsd = new InMemoryFxLookup([
      fxRate(USD, "2026-01-05", "4.00"),
      fxRate(USD, "2026-02-20", "4.10"),
    ]);
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "600", { currency: USD }),
      buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", { currency: USD }),
      cashTxn(ACC, "2026-01-02", "1000"),
      buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100"),
    ]);

    const valued = valuePortfolio(snapshot, MARKET, oldUsd, PLN, 5);
    const [etf, stock] = two(valued.valued);
    expect([k(etf.marketValueBase), etf.weight, etf.missingFxCurrency]).toEqual([null, null, USD]);
    expect(k(etf.costBasisBase)).toBe(k(d("2000"))); // the trade-date rate of 2026-01-05 is fresh
    expect(valued.cash.find((c) => c.cash.currency === USD)?.amountBase).toBeNull();
    expect(valued.missingFxCurrencies).toEqual(new Set([USD]));
    expect(k(valued.totalBase)).toBe(k(d("1020"))); // PKN 120 + 900 PLN cash
    expect(stock.weight).toBeCloseTo(120 / 1020, 6);
    expect(ws(valued.warnings)).toContain(
      warningKey(
        staleFxRate({
          currency: USD,
          base: PLN,
          date: AS_OF,
          rateDate: "2026-02-20",
          ageDays: 18,
        }),
      ),
    );
    expect(valued.warnings.filter((w) => w.kind === "missing_fx_rate")).toEqual([]);

    // A looser limit accepts the same rate.
    const loose = valuePortfolio(snapshot, MARKET, oldUsd, PLN, 5, { maxFxAgeDays: 20 });
    expect(loose.missingFxCurrencies).toEqual(new Set());
    expect(k((loose.valued[0] as ValuedHolding).marketValueBase)).toBe(k(d("2255"))); // 5 x 110 x 4.10
  });

  // test_price_currency_names_the_currency_of_the_price_r15
  it("price currency names the currency of the price (R15)", () => {
    const eurListed = instrument(null, {
      name: "EUR ETF",
      symbol: "EXX",
      mic: "XETR",
      currency: EUR,
    });
    const mixedBond = instrument(null, {
      name: "Mixed bond",
      symbol: null,
      mic: null,
      assetClass: AssetClass.BOND,
      valuationMode: ValuationMode.COST,
    });
    const valued = valuePortfolio(
      snapshotOf([
        cashTxn(ACC, "2026-01-02", "10000"),
        buy(ACC, eurListed.id, "2026-01-05", "2", "400"), // lot booked in PLN
        buy(ACC, FUND.id, "2026-01-05", "1", "30", { currency: USD }),
        buy(ACC, mixedBond.id, "2026-01-05", "1", "100"), // 100 PLN
        buy(ACC, mixedBond.id, "2026-01-05", "1", "50", { currency: USD }), // 50 USD x 4.00
      ]),
      marketView(AS_OF, {
        instruments: [eurListed, FUND, mixedBond],
        bars: [bar(eurListed.id, "2026-03-10", "101")],
      }),
      FX,
      PLN,
      5,
    );
    const [etf, fundHolding, bond] = three(valued.valued);
    expect([k(etf.price), etf.priceCurrency, k(etf.marketValueBase)]).toEqual([
      k(d("101")),
      EUR,
      k(d("808")),
    ]);
    expect(etf.holding.currency).toBe(PLN); // the lot currency differs from the price currency
    // last trade price
    expect([k(fundHolding.price), fundHolding.priceCurrency]).toEqual([k(d("30")), USD]);
    // Lots in PLN and USD: no average cost in one lot currency, so the price is in the base currency.
    expect(holdingAverageCost(bond.holding)).toBeNull();
    expect([k(bond.price), bond.priceCurrency, k(bond.marketValueBase)]).toEqual([
      k(d("150")),
      PLN,
      k(d("300")),
    ]);
  });

  // test_realized_trades_keep_currencies_apart_and_get_a_base_result_r12
  it("realized trades keep currencies apart and get a base result (R12)", () => {
    const eurEtf = instrument(null, {
      name: "EUR ETF",
      symbol: "EXX",
      mic: "XETR",
      currency: EUR,
    });
    const buyEur = buy(ACC, eurEtf.id, "2026-01-05", "10", "100", { currency: EUR }); // 1000 EUR
    const sellPln = sell(ACC, eurEtf.id, "2026-03-10", "10", "440"); // 4400 PLN
    const samePln = [
      buy(ACC, PL_STOCK.id, "2026-01-05", "2", "100"),
      sell(ACC, PL_STOCK.id, "2026-03-10", "2", "130"),
    ];
    const snapshot = snapshotOf([buyEur, sellPln, ...samePln]);

    const mixed = snapshot.realized.find((t) => t.instrumentId === eurEtf.id);
    expect(mixed).toBeDefined();
    if (mixed === undefined) return;
    expect([mixed.currency, mixed.costCurrency, mixed.pnl]).toEqual([PLN, EUR, null]);
    expect([k(realizedProceeds(mixed)), k(realizedCost(mixed))]).toEqual([
      k(d("4400")),
      k(d("1000")),
    ]);
    // the mixed trade is never summed
    expect([...realizedPnlByCurrency(snapshot)].map(([c, v]) => [c, k(v)])).toEqual([
      [PLN, k(d("60"))],
    ]);
    expect(ws(snapshot.warnings)).toContain(
      warningKey(
        realizedCurrencyMismatch({
          accountId: ACC,
          instrumentId: eurEtf.id,
          txnId: sellPln.id,
          date: "2026-03-10",
          saleCurrency: PLN,
          lotCurrencies: [EUR],
        }),
      ),
    );

    const valued = valuePortfolio(
      snapshot,
      marketView(AS_OF, { instruments: [eurEtf, PL_STOCK] }),
      FX,
      PLN,
      5,
    );
    const base = valued.realized.find((t) => t.trade.instrumentId === eurEtf.id);
    expect(base).toBeDefined();
    if (base === undefined) return;
    // Proceeds 4400 PLN; cost 1000 EUR at the buy-date rate 5.00 = 5000 PLN.
    expect([k(base.proceedsBase), k(base.costBase), k(realizedPnlBase(base))]).toEqual([
      k(d("4400")),
      k(d("5000")),
      k(d("-600")),
    ]);
    expect(k(portfolioRealizedPnlBase(valued))).toBe(k(d("-540"))); // -600 + 60
  });

  // test_an_unknown_cost_basis_keeps_the_market_value_but_no_cost_numbers
  it("an unknown cost basis keeps the market value but no cost numbers", () => {
    const valued = valuePortfolio(
      snapshotOf([transferIn(ACC, PL_STOCK.id, "2026-01-05", "10")]),
      MARKET,
      FX,
      PLN,
      5,
    );
    const holding = one(valued.valued);
    expect(holdingHasUnknownCost(holding.holding)).toBe(true);
    expect(k(holding.marketValueBase)).toBe(k(d("1200")));
    expect(holding.costBasisBase).toBeNull();
    expect(holding.unrealizedPct).toBeNull();
    expect(holding.weight).toBe(1.0);
  });

  // test_an_instrument_missing_from_the_market_view_gets_a_placeholder
  it("an instrument missing from the market view gets a placeholder", () => {
    const valued = valuePortfolio(
      snapshotOf([buy(ACC, PL_STOCK.id, "2026-01-05", "1", "100")]),
      marketView(AS_OF, { bars: [bar(PL_STOCK.id, "2026-03-09", "120")] }),
      FX,
      PLN,
      5,
    );
    const first = valued.valued[0] as ValuedHolding;
    const placeholder = first.instrument;
    expect(placeholder.id).toBe(PL_STOCK.id);
    expect(placeholder.assetClass).toBe(AssetClass.OTHER);
    expect(placeholder.needsClassification).toBe(true);
    expect(k(first.marketValueBase)).toBe(k(d("120")));
    expect(ws(valued.warnings)).toEqual(ws([missingInstrument({ instrumentId: PL_STOCK.id })]));
  });

  // test_a_non_pln_base_currency_converts_through_pln_cross_rates
  it("a non-PLN base currency converts through PLN cross rates", () => {
    const valued = valuePortfolio(
      snapshotOf([
        buy(ACC, PL_STOCK.id, "2026-01-05", "10", "100"), // 1000 PLN / 5.00 = 200 EUR
        buy(ACC, USD_ETF.id, "2026-01-05", "5", "100", { currency: USD }), // 500x4.00/5.00 = 400
        cashTxn(ACC, "2026-01-02", "1000"),
        cashTxn(ACC, "2026-01-02", "500", { currency: USD }),
      ]),
      MARKET,
      FX,
      EUR,
      5,
    );
    const [a, b] = two(valued.valued);
    // 1200 / 4.00
    expect([k(a.marketValueBase), k(a.costBasisBase)]).toEqual([k(d("300")), k(d("200"))]);
    // 550 x 4.20 / 4.00
    expect([k(b.marketValueBase), k(b.costBasisBase)]).toEqual([k(d("577.5")), k(d("400"))]);
    expect(k(valued.cashBase)).toBe(k(d("0"))); // PLN 0 and USD 0 left after the buys
    expect(k(valued.totalBase)).toBe(k(d("877.5")));
  });

  // test_the_account_filter_values_only_the_given_accounts
  it("the account filter values only the given accounts", () => {
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "1000"),
      cashTxn(IKE, "2026-01-02", "500"),
      buy(ACC, PL_STOCK.id, "2026-01-05", "5", "100"),
      buy(IKE, PL_STOCK.id, "2026-01-05", "2", "100"),
      sell(IKE, STALE.id, "2026-01-06", "1", "10"), // gap in IKE
    ]);

    const valued = valuePortfolio(snapshot, MARKET, FX, PLN, 5, { accountIds: new Set([IKE]) });

    const holding = one(valued.valued);
    expect(holding.holding.accountId).toBe(IKE);
    expect(k(holding.marketValueBase)).toBe(k(d("240")));
    expect(k(valued.cashBase)).toBe(k(d("310"))); // 500 - 200 + 10
    expect(k(valued.totalBase)).toBe(k(d("550")));
    expect(valued.snapshot.holdings.map((h) => h.accountId)).toEqual([IKE]);
    expect(valued.snapshot.warnings).toHaveLength(1);
    const gap = valued.snapshot.warnings[0] as PortfolioWarning;
    expect(gap.kind).toBe("history_gap");
    expect(
      valuePortfolio(snapshot, MARKET, FX, PLN, 5, { accountIds: new Set([ACC]) }).snapshot
        .warnings,
    ).toEqual([]);
  });

  // test_an_empty_portfolio_has_a_zero_total_and_no_stale_weight
  it("an empty portfolio has a zero total and no stale weight", () => {
    const valued = valuePortfolio(snapshotOf([]), MARKET, FX, PLN, 5);
    expect(k(valued.totalBase)).toBe(k(d("0")));
    expect(valued.staleWeight).toBe(0);
    expect(valued.valued).toEqual([]);
  });
});

// --- Stage 2: manual valuation and frozen instruments ------------------------------------------

describe("manual valuation and frozen instruments", () => {
  // test_manual_mode_uses_the_newest_valuation_on_or_before_the_date_and_is_never_stale
  it("manual mode uses the newest valuation on or before the date and is never stale", () => {
    const claim = instrument(null, {
      name: "Exchange claim",
      symbol: null,
      mic: null,
      assetClass: AssetClass.CLAIM,
    });
    expect(claim.valuationMode).toBe(ValuationMode.MANUAL); // default for claims
    const snapshot = snapshotOf(
      [transferIn(ACC, claim.id, "2026-01-05", "1000", { price: "0.4" })], // cost 400 PLN
    );
    const view = marketView(AS_OF, {
      instruments: [claim],
      bars: [bar(claim.id, "2026-03-09", "999")], // bars are ignored in manual mode
      manualValuations: [
        manual(claim.id, "2025-12-01", "0.30"),
        manual(claim.id, "2026-02-01", "0.25", USD), // 1000 x 0.25 USD x 4.20 = 1050 PLN
        manual(claim.id, "2026-04-01", "0.90"), // after as_of
      ],
    });

    const valued = valuePortfolio(snapshot, view, FX, PLN, 5);

    const holding = one(valued.valued);
    expect([k(holding.price), holding.priceCurrency, holding.priceDate]).toEqual([
      k(d("0.25")),
      USD,
      "2026-02-01",
    ]);
    expect(k(holding.marketValueBase)).toBe(k(d("1050")));
    expect(k(holding.costBasisBase)).toBe(k(d("400")));
    expect([holding.isStale, valuedManually(holding), valuedAtCost(holding)]).toEqual([
      false,
      true,
      false,
    ]);
    expect(holding.weight).toBe(1.0);
    expect(valued.staleWeight).toBe(0);
    expect(valued.warnings).toEqual([]);
  });

  // test_manual_mode_without_a_valuation_excludes_the_holding
  it("manual mode without a valuation excludes the holding", () => {
    const privateFund = instrument(null, {
      name: "Private fund",
      symbol: null,
      mic: null,
      valuationMode: ValuationMode.MANUAL,
    });
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "1000"),
      buy(ACC, privateFund.id, "2026-01-05", "1", "500"),
    ]);
    const view = marketView(AS_OF, {
      instruments: [privateFund],
      manualValuations: [manual(privateFund.id, "2026-04-01", "600")], // only after as_of
    });

    const valued = valuePortfolio(snapshot, view, FX, PLN, 5);

    const holding = one(valued.valued);
    expect([holding.price, holding.marketValueBase, holding.weight]).toEqual([null, null, null]);
    expect(holding.isStale).toBe(true); // no price at all, like an unpriced market holding
    expect(k(valued.totalBase)).toBe(k(d("500"))); // cash only
    expect(ws(valued.warnings)).toEqual(
      ws([missingManualValuation({ instrumentId: privateFund.id, asOf: AS_OF })]),
    );
  });

  // test_a_frozen_instrument_defaults_to_manual_zero_until_a_valuation_is_set
  it("a frozen instrument defaults to manual zero until a valuation is set", () => {
    const frozenAdr = instrument(null, {
      name: "Frozen ADR",
      symbol: "FRZ",
      mic: "XNAS",
      currency: USD,
      status: InstrumentStatus.FROZEN,
    });
    expect(frozenAdr.valuationMode).toBe(ValuationMode.MARKET); // configured mode stays
    expect(fetchesMarketData(frozenAdr)).toBe(false);
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "1000"),
      buy(ACC, frozenAdr.id, "2026-01-05", "10", "20", { currency: USD }), // 200 USD x 4.00 = 800
      cashTxn(ACC, "2026-01-02", "200", { currency: USD }),
    ]);
    const view = marketView(AS_OF, {
      instruments: [frozenAdr],
      bars: [bar(frozenAdr.id, "2026-03-09", "21")],
    });

    // No rates at all: a value of exactly 0 needs none, so weights stay computable.
    const noFx = valuePortfolio(snapshot, view, new InMemoryFxLookup([]), PLN, 5);
    const zero = one(noFx.valued);
    expect([k(zero.price), zero.priceCurrency, zero.priceDate]).toEqual([k(d("0")), USD, null]);
    expect([k(zero.marketValueBase), valuedManually(zero), zero.isStale]).toEqual([
      k(d("0")),
      true,
      false,
    ]);
    expect(zero.missingFxCurrency).toBeNull();
    expect(ws(noFx.warnings)).toEqual(
      ws([
        frozenValuedAtZero({ instrumentId: frozenAdr.id }),
        missingFxRate({ currency: USD, base: PLN, date: "2026-01-05" }),
      ]),
    );

    const zeroFx = valuePortfolio(snapshot, view, FX, PLN, 5);
    const holding = one(zeroFx.valued);
    expect(k(holding.marketValueBase)).toBe(k(d("0")));
    expect(k(holding.costBasisBase)).toBe(k(d("800")));
    expect(holding.unrealizedPct).toBeCloseTo(-1.0, 6);
    expect(holding.weight).toBe(0.0);
    expect(k(zeroFx.totalBase)).toBe(k(d("1000")));

    // A manual valuation set by the owner replaces the default 0.
    const valuedLater = valuePortfolio(
      snapshot,
      marketView(AS_OF, {
        instruments: [frozenAdr],
        manualValuations: [manual(frozenAdr.id, "2026-03-01", "5", USD)],
      }),
      FX,
      PLN,
      5,
    );
    const setByOwner = one(valuedLater.valued);
    expect(k(setByOwner.marketValueBase)).toBe(k(d("210"))); // 10 x 5 USD x 4.20
    expect(setByOwner.priceDate).toBe("2026-03-01");
    expect(valuedLater.warnings).toEqual([]);
  });

  // test_a_delisted_instrument_keeps_its_valuation_mode
  it("a delisted instrument keeps its valuation mode", () => {
    const delisted = instrument(null, {
      name: "Gone",
      symbol: "GON",
      status: InstrumentStatus.DELISTED,
    });
    expect(fetchesMarketData(delisted)).toBe(false);
    const snapshot = snapshotOf([
      cashTxn(ACC, "2026-01-02", "100"),
      buy(ACC, delisted.id, "2026-01-05", "1", "100"),
    ]);
    const valued = valuePortfolio(
      snapshot,
      marketView(AS_OF, {
        instruments: [delisted],
        bars: [bar(delisted.id, "2026-01-20", "80")],
      }),
      FX,
      PLN,
      5,
    );
    const holding = one(valued.valued);
    expect([holding.valuationMode, k(holding.price), holding.isStale]).toEqual([
      ValuationMode.MARKET,
      k(d("80")),
      true,
    ]);
  });
});
