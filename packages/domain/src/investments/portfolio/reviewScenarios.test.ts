/**
 * Test-for-test translation of `tests/investments/portfolio/test_inv_review_scenarios.py`: Stage 1
 * review findings (R1-R15), the pure portfolio part of each Kompas pipeline scenario.
 *
 * Each scenario runs the real pipeline `buildSnapshot` -> `valuePortfolio` -> `allocate` and asserts
 * the corrected numbers. Rule verdicts live with the rules engine; import-side fixes (R5 cash from
 * gross, R8 dedup, R9 time-of-day ranking, R10 instrument currency) are represented by the transactions
 * an import with those fixes stores. R3 and R6 (market data) are covered in `tests/investments/market`.
 * Synthetic data only. Each `it` names its Python test in a comment.
 */
import { describe, expect, it } from "vitest";
import { addDays, type DateTime, weekday } from "../../dates.js";
import { type Decimal, decimalKey } from "../../decimal.js";
import {
  type AllocationPlan,
  AssetClass,
  allocationOf,
  allocationPlan,
  asAccountId,
  asInstrumentId,
  asProfileId,
  bucketDef,
  bucketMatch,
  type Currency,
  cashHistoryGap,
  type DatedPrice,
  type FxRate,
  type Instrument,
  type InstrumentId,
  missingFxRate,
  missingPrice,
  type PortfolioWarning,
  type PriceBar,
  portfolioRealizedPnlBase,
  priceBar,
  realizedPnlBase,
  realizedPnlByCurrency,
  staleFxRate,
  type Transaction,
  TxnSource,
  TxnType,
  unclassifiedWeight,
  type ValuedPortfolio,
  warningKey,
} from "../domain/index.js";
import { allocate, buildSnapshot, InMemoryFxLookup, valuePortfolio } from "./index.js";
import {
  buildTxn,
  d,
  EUR,
  fxRate,
  instrument,
  marketView,
  newId,
  PLN,
  USD,
} from "./testing/fixtures.js";

const PROFILE = asProfileId(newId());
const ACCOUNT = newId();
const AS_OF = "2026-10-01";

function at(y: number, m: number, dd: number, h = 0): DateTime {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${y}-${pad(m)}-${pad(dd)}`,
    hour: h,
    minute: 0,
    second: 0,
    microsecond: 0,
    offsetSeconds: 0,
  };
}

/** Weekday bars from `start` to `end` at a flat close. */
function dailyBars(
  instrumentId: InstrumentId,
  start: string,
  end: string,
  close: string,
): PriceBar[] {
  const bars: PriceBar[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    if (weekday(current) < 5) {
      bars.push(priceBar({ instrumentId, date: current, close: d(close), source: "test" }));
    }
  }
  return bars;
}

function dailyRates(quote: Currency, start: string, end: string, rate: string): FxRate[] {
  const rates: FxRate[] = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    if (weekday(current) < 5) rates.push(fxRate(quote, current, rate));
  }
  return rates;
}

function deposit(
  tradeDate: string,
  amount: string,
  {
    currency = PLN,
    account = ACCOUNT,
    createdAt = null,
  }: { currency?: Currency; account?: string; createdAt?: DateTime | null } = {},
): Transaction {
  return buildTxn(account, null, {
    type: TxnType.DEPOSIT,
    tradeDate,
    quantity: null,
    price: null,
    currency,
    grossAmount: amount,
    cashAmount: amount,
    createdAt,
  });
}

function run(
  txns: Transaction[],
  instruments: Instrument[],
  bars: PriceBar[] = [],
  fx: FxRate[] = [],
  {
    maxFxAgeDays = 10,
    lastKnownPrices = null,
    plan = null,
  }: {
    maxFxAgeDays?: number;
    lastKnownPrices?: ReadonlyMap<InstrumentId, DatedPrice> | null;
    plan?: AllocationPlan | null;
  } = {},
) {
  const snapshot = buildSnapshot(PROFILE, txns, AS_OF);
  const market = marketView(AS_OF, { instruments, bars });
  const valued = valuePortfolio(snapshot, market, new InMemoryFxLookup(fx), PLN, 5, {
    maxFxAgeDays,
    ...(lastKnownPrices === null ? {} : { lastKnownPrices }),
  });
  const allocation = plan === null ? null : allocate(valued, plan);
  return { snapshot, valued, allocation };
}

function holdingOf(valued: ValuedPortfolio, symbol: string) {
  const found = valued.valued.find((v) => v.instrument.symbol === symbol);
  if (found === undefined) throw new Error(`no holding ${symbol}`);
  return found;
}

/** Python `Decimal == Decimal(expected)` (by value); null never equals. */
function expectD(actual: Decimal | null | undefined, expected: string): void {
  expect(actual == null ? null : decimalKey(actual)).toBe(decimalKey(d(expected)));
}

/** Python `warning in warnings` (dataclass equality, decimals by value). */
function expectWarningIn(warning: PortfolioWarning, warnings: readonly PortfolioWarning[]): void {
  expect(warnings.map(warningKey)).toContain(warningKey(warning));
}

const PASSIVE_LIKE = allocationPlan({
  buckets: [
    bucketDef({ id: "global_equity", match: bucketMatch({ tags: ["global_equity"] }) }),
    bucketDef({ id: "bonds", match: bucketMatch({ assetClasses: [AssetClass.TREASURY_BOND] }) }),
    bucketDef({ id: "cash", match: bucketMatch({ assetClasses: [AssetClass.CASH] }) }),
  ],
  targets: { global_equity: 0.7, bonds: 0.2, cash: 0.1 },
});

describe("review scenarios", () => {
  // test_r1_untagged_imported_etf_is_unclassified_and_tagging_fixes_the_direction
  it("r1 untagged imported etf is unclassified and tagging fixes the direction", () => {
    const vwrl = instrument(null, {
      name: "Vanguard FTSE All-World UCITS ETF",
      symbol: "VWRL",
      assetClass: AssetClass.ETF,
      needsClassification: true,
    });
    const txns = [
      deposit("2026-09-01", "10000"),
      buildTxn(ACCOUNT, vwrl.id, { tradeDate: "2026-09-02", quantity: "90", price: "100" }),
    ];
    const bars = dailyBars(vwrl.id, "2026-09-02", AS_OF, "100");

    const { valued, allocation } = run(txns, [vwrl], bars, [], { plan: PASSIVE_LIKE });
    if (allocation === null) throw new Error("no allocation");
    expectD(valued.totalBase, "10000");
    expect(allocation.unclassified.map((h) => h.instrument.symbol)).toEqual(["VWRL"]);
    expectD(allocation.unclassifiedValueBase, "9000");
    expect(unclassifiedWeight(allocation)).toBeCloseTo(0.9, 6); // rules skip above 0.02

    const tagged = instrument(vwrl.id, {
      name: vwrl.name,
      symbol: "VWRL",
      assetClass: AssetClass.ETF,
      tags: ["global_equity"],
    });
    const after = run(txns, [tagged], bars, [], { plan: PASSIVE_LIKE }).allocation;
    if (after === null) throw new Error("no allocation");
    expect(after.unclassified).toEqual([]);
    const globalEquity = allocationOf(after, "global_equity");
    if (globalEquity === null) throw new Error("no global_equity");
    expect(globalEquity.weight).toBeCloseTo(0.9, 6);
    expect(globalEquity.driftPp).toBeCloseTo(20.0, 4); // overweight, not "70 pp underweight"
    expectD(globalEquity.driftValueBase, "2000");
  });

  // test_r1_a_small_unclassified_share_stays_small
  it("r1 a small unclassified share stays small", () => {
    const vwrl = instrument(null, {
      symbol: "VWRL",
      assetClass: AssetClass.ETF,
      tags: ["global_equity"],
    });
    const gold = instrument(null, { symbol: "GLD", assetClass: AssetClass.COMMODITY });
    const txns = [
      deposit("2026-09-01", "10000"),
      buildTxn(ACCOUNT, vwrl.id, { tradeDate: "2026-09-02", quantity: "70", price: "100" }),
      buildTxn(ACCOUNT, gold.id, { tradeDate: "2026-09-02", quantity: "1", price: "100" }),
    ];
    const bars = [
      ...dailyBars(vwrl.id, "2026-09-02", AS_OF, "100"),
      ...dailyBars(gold.id, "2026-09-02", AS_OF, "100"),
    ];
    const { allocation } = run(txns, [vwrl, gold], bars, [], { plan: PASSIVE_LIKE });
    if (allocation === null) throw new Error("no allocation");
    expectD(allocation.unclassifiedValueBase, "100");
    expect(unclassifiedWeight(allocation)).toBeCloseTo(0.01, 8);
    expect(allocationOf(allocation, "global_equity")?.weight).toBeCloseTo(0.7, 6);
  });

  // test_r2_negative_cash_counts_as_zero_and_weights_are_real
  it("r2 negative cash counts as zero and weights are real", () => {
    const aaa = instrument(null, { name: "AAA SA", symbol: "AAA" });
    const bbb = instrument(null, { name: "BBB SA", symbol: "BBB" });
    const plan = allocationPlan({
      buckets: [
        bucketDef({ id: "stocks", match: bucketMatch({ assetClasses: [AssetClass.EQUITY] }) }),
        bucketDef({ id: "cash", match: bucketMatch({ assetClasses: [AssetClass.CASH] }) }),
      ],
      targets: { stocks: 0.95, cash: 0.05 },
    });
    const { snapshot, valued, allocation } = run(
      [
        deposit("2026-09-01", "70000", { createdAt: at(2026, 9, 1) }),
        buildTxn(ACCOUNT, aaa.id, { tradeDate: "2026-09-02", quantity: "100", price: "600" }),
        buildTxn(ACCOUNT, bbb.id, { tradeDate: "2026-09-03", quantity: "100", price: "400" }),
      ],
      [aaa, bbb],
      [
        ...dailyBars(aaa.id, "2026-09-02", AS_OF, "600"),
        ...dailyBars(bbb.id, "2026-09-03", AS_OF, "400"),
      ],
      [],
      { plan },
    );
    if (allocation === null) throw new Error("no allocation");
    expect(snapshot.warnings.map(warningKey)).toEqual(
      [
        cashHistoryGap({
          accountId: asAccountId(ACCOUNT),
          currency: PLN,
          amount: d("-30000"),
          asOf: AS_OF,
        }),
      ].map(warningKey),
    );
    expectD(valued.cash[0]?.amountBase, "-30000");
    expectD(valued.cashBase, "0");
    expectD(valued.totalBase, "100000");
    expect(holdingOf(valued, "AAA").weight).toBe(0.6); // a real 60 % position
    expect(holdingOf(valued, "BBB").weight).toBe(0.4); // not the old 57 %
    expect(allocationOf(allocation, "cash")?.cashHistoryGap).toBe(true);
    expect(allocationOf(allocation, "stocks")?.cashHistoryGap).toBe(false);
  });

  function r4History(pkn: Instrument, aapl: Instrument): Transaction[] {
    return [
      deposit("2026-09-01", "50200", { currency: USD, createdAt: at(2026, 9, 1) }),
      deposit("2026-09-01", "1000", { createdAt: at(2026, 9, 1, 1) }),
      buildTxn(ACCOUNT, pkn.id, { tradeDate: "2026-09-02", createdAt: at(2026, 9, 2) }),
      buildTxn(ACCOUNT, aapl.id, {
        tradeDate: "2026-09-02",
        quantity: "1",
        price: "200",
        currency: USD,
        createdAt: at(2026, 9, 2, 1),
      }),
    ];
  }

  function r4Setup(): [Instrument, Instrument, PriceBar[]] {
    const pkn = instrument();
    const aapl = instrument(null, { name: "Apple", symbol: "AAPL", mic: "XNAS", currency: USD });
    const bars = [
      ...dailyBars(pkn.id, "2026-09-02", AS_OF, "100"),
      ...dailyBars(aapl.id, "2026-09-02", AS_OF, "100"), // AAPL down 50 % from cost
    ];
    return [pkn, aapl, bars];
  }

  function expectUsdLeftOut(valued: ValuedPortfolio): void {
    expect(valued.missingFxCurrencies).toEqual(new Set([USD]));
    expectD(valued.totalBase, "1000"); // PKN only; the USD amounts are unknown, not zero
    const aapl = holdingOf(valued, "AAPL");
    expect([aapl.missingFxCurrency, aapl.marketValueBase, aapl.weight]).toEqual([USD, null, null]);
    expect(valued.cash.find((c) => c.cash.currency === USD)?.amountBase).toBeNull();
  }

  // test_r4_no_usd_rate_leaves_usd_amounts_out_and_names_the_currency
  it("r4 no usd rate leaves usd amounts out and names the currency", () => {
    const [pkn, aapl, bars] = r4Setup();
    const { valued } = run(r4History(pkn, aapl), [pkn, aapl], bars);
    expectUsdLeftOut(valued);
    expectWarningIn(missingFxRate({ currency: USD, base: PLN, date: AS_OF }), valued.warnings);
  });

  // test_r14_a_usd_rate_older_than_max_fx_age_days_counts_as_missing
  it("r14 a usd rate older than max fx age days counts as missing", () => {
    const [pkn, aapl, bars] = r4Setup();
    const stale = dailyRates(USD, "2026-08-25", "2026-09-15", "4.00"); // 16 days before as_of
    const { valued } = run(r4History(pkn, aapl), [pkn, aapl], bars, stale);
    expectUsdLeftOut(valued);
    expectWarningIn(
      staleFxRate({
        currency: USD,
        base: PLN,
        date: AS_OF,
        rateDate: "2026-09-15",
        ageDays: 16,
      }),
      valued.warnings,
    );

    const loose = run(r4History(pkn, aapl), [pkn, aapl], bars, stale, { maxFxAgeDays: 20 }).valued;
    expect(loose.missingFxCurrencies.size).toBe(0);
    // PKN 1000 + AAPL 1 x 100 x 4 = 400 + USD cash 50000 x 4 = 200000 + PLN cash 0.
    expectD(loose.totalBase, "201400");
    expect(holdingOf(loose, "PKN").weight).toBeCloseTo(1000 / 201400, 9);
    expect(holdingOf(loose, "AAPL").unrealizedPct).toBeCloseTo(-0.5, 6);
  });

  // test_r5_cash_derived_across_currencies_values_correctly
  it("r5 cash derived across currencies values correctly", () => {
    // The fixed generic CSV import stores buy 10 @ 100 USD settled in PLN at fx 4.0 as -4000 PLN.
    const usdStock = instrument(null, {
      name: "US stock",
      symbol: "USS",
      mic: "XNAS",
      currency: USD,
    });
    const txns = [
      deposit("2026-09-01", "10000"),
      buildTxn(ACCOUNT, usdStock.id, {
        tradeDate: "2026-09-02",
        quantity: "10",
        price: "100",
        currency: USD,
        cashAmount: "-4000",
        cashCurrency: PLN,
        fxRate: "4.0",
      }),
    ];
    const rates = dailyRates(USD, "2026-08-25", AS_OF, "4.00");
    const { valued } = run(
      txns,
      [usdStock],
      dailyBars(usdStock.id, "2026-09-02", AS_OF, "100"),
      rates,
    );
    expectD(valued.cashBase, "6000");
    expectD(valued.totalBase, "10000");
    const cashBase = valued.cash[0]?.amountBase;
    if (cashBase == null) throw new Error("no cash base");
    expectD(cashBase.div(valued.totalBase), "0.6");
  });

  // test_r8_every_partial_fill_counts_once
  it("r8 every partial fill counts once", () => {
    // What the fixed dedup stores from two overlapping exports: fill A (5 @ 60) and fill B (7 @ 61).
    const pkn = instrument();
    const txns = [
      deposit("2026-09-01", "5000"),
      buildTxn(ACCOUNT, pkn.id, { tradeDate: "2026-09-02", quantity: "5", price: "60" }),
      buildTxn(ACCOUNT, pkn.id, { tradeDate: "2026-09-02", quantity: "7", price: "61" }),
    ];
    const { valued } = run(txns, [pkn], dailyBars(pkn.id, "2026-09-02", AS_OF, "60"));
    const h = holdingOf(valued, "PKN");
    expectD(h.holding.quantity, "12");
    expectD(h.costBasisBase, "727");
    expectD(valued.cashBase, "4273");
  });

  // test_r9_same_day_rows_follow_their_import_rank_not_the_file_order
  it("r9 same day rows follow their import rank not the file order", () => {
    // The fixed import ranks the 10:00 buy before the 15:00 sell (created_at increasing).
    const pkn = instrument();
    const sell = buildTxn(ACCOUNT, pkn.id, {
      type: TxnType.SELL,
      tradeDate: "2026-09-02",
      quantity: "10",
      price: "71",
      cashAmount: "710",
      createdAt: at(2026, 9, 2, 15),
    });
    const buy = buildTxn(ACCOUNT, pkn.id, {
      tradeDate: "2026-09-02",
      quantity: "10",
      price: "60",
      createdAt: at(2026, 9, 2, 10),
    });
    const { snapshot, valued } = run(
      [sell, buy],
      [pkn],
      dailyBars(pkn.id, "2026-09-01", AS_OF, "70"),
    );
    expect(snapshot.holdings).toEqual([]);
    expect(snapshot.warnings).toEqual([]); // no HistoryGap
    expectD(snapshot.realized[0]?.pnl, "110");
    expectD(valued.cashBase, "110");
  });

  // test_r10_an_instrument_in_its_trade_currency_values_at_cost
  it("r10 an instrument in its trade currency values at cost", () => {
    // The fixed resolver creates AAPL in USD (from the priced buy, not the PLN tax / dividend rows).
    const aapl = instrument(null, { name: "Apple", symbol: "AAPL", mic: null, currency: USD });
    const txns = [
      deposit("2026-09-01", "1500", { currency: USD }),
      buildTxn(ACCOUNT, aapl.id, {
        tradeDate: "2026-09-02",
        quantity: "10",
        price: "150",
        currency: USD,
      }),
      buildTxn(ACCOUNT, aapl.id, {
        type: TxnType.DIVIDEND,
        tradeDate: "2026-09-10",
        quantity: null,
        price: null,
        grossAmount: "20",
        cashAmount: "20",
      }),
      buildTxn(ACCOUNT, aapl.id, {
        type: TxnType.TAX,
        tradeDate: "2026-09-10",
        quantity: null,
        price: null,
        grossAmount: "3",
        cashAmount: "-3",
      }),
    ];
    const { valued } = run(
      txns,
      [aapl],
      dailyBars(aapl.id, "2026-09-02", AS_OF, "150"),
      dailyRates(USD, "2026-08-25", AS_OF, "4.00"),
    );
    const h = holdingOf(valued, "AAPL");
    expectD(h.price, "150");
    expect(h.priceCurrency).toBe(USD);
    expectD(h.marketValueBase, "6000");
    expectD(h.costBasisBase, "6000");
    expect(h.unrealizedPct).toBe(0.0);
    expectD(valued.cashBase, "17"); // 20 - 3 PLN; USD cash 0
  });

  // test_r11_the_fallback_price_is_split_once_across_accounts
  it("r11 the fallback price is split once across accounts", () => {
    const a = newId();
    const b = newId();
    const fund = instrument(null, {
      name: "Fund",
      symbol: "FND",
      mic: null,
      assetClass: AssetClass.FUND,
    });
    const asOf = "2026-03-01";

    const splitOn = (account: string, on: string): Transaction =>
      buildTxn(account, fund.id, {
        type: TxnType.SPLIT,
        tradeDate: on,
        quantity: null,
        price: null,
        cashAmount: "0",
        splitRatio: "2",
        createdAt: { ...at(2026, 1, 1), date: on },
      });

    const txns = [
      deposit("2026-01-02", "1000", { account: a, createdAt: at(2026, 1, 2) }),
      deposit("2026-01-02", "1000", { account: b, createdAt: at(2026, 1, 2) }),
      buildTxn(a, fund.id, { tradeDate: "2026-01-10", createdAt: at(2026, 1, 10) }),
      buildTxn(b, fund.id, { tradeDate: "2026-01-10", createdAt: at(2026, 1, 10) }),
      splitOn(a, "2026-02-02"),
      splitOn(b, "2026-02-03"),
    ];
    const snapshot = buildSnapshot(PROFILE, txns, asOf);
    const valued = valuePortfolio(
      snapshot,
      marketView("2026-03-01", { instruments: [fund] }),
      new InMemoryFxLookup([]),
      PLN,
      5,
    );
    expectD(snapshot.lastTradePrices.get(fund.id)?.price, "50");
    expect(
      valued.valued.map((v) => [decimalKey(v.holding.quantity), decimalKey(v.marketValueBase)]),
    ).toEqual([
      ["20", "1000"],
      ["20", "1000"],
    ]);
    expectD(valued.totalBase, "2000"); // was 1000: 20 + 20 units at a double-split 25
  });

  // test_r12_a_pln_sell_of_a_eur_lot_has_no_mixed_pnl_and_a_base_result_at_trade_date_fx
  it("r12 a pln sell of a eur lot has no mixed pnl and a base result at trade date fx", () => {
    const etf = instrument(null, { name: "EUR ETF", symbol: "EXX", mic: "XETR", currency: EUR });
    const asOf = "2026-03-01";
    const txns = [
      buildTxn(ACCOUNT, etf.id, { currency: EUR, createdAt: at(2026, 1, 5) }), // 10 @ 100 EUR
      buildTxn(ACCOUNT, etf.id, {
        type: TxnType.SELL,
        tradeDate: "2026-02-16",
        price: "440",
        cashAmount: "4400",
        createdAt: at(2026, 2, 16),
      }),
    ];
    const snapshot = buildSnapshot(PROFILE, txns, asOf);
    const valued = valuePortfolio(
      snapshot,
      marketView("2026-03-01", { instruments: [etf] }),
      new InMemoryFxLookup([fxRate(EUR, "2026-01-05", "4.30"), fxRate(EUR, "2026-02-16", "4.25")]),
      PLN,
      5,
    );
    expect(snapshot.realized).toHaveLength(1);
    const trade = snapshot.realized[0];
    if (trade === undefined) throw new Error("no trade");
    expect([trade.currency, trade.costCurrency, trade.pnl]).toEqual([PLN, EUR, null]);
    expect(realizedPnlByCurrency(snapshot).size).toBe(0); // was {PLN: 3400} = 4400 PLN - 1000 EUR
    const first = valued.realized[0];
    if (first === undefined) throw new Error("no valued trade");
    expectD(realizedPnlBase(first), "100"); // 4400 PLN - 1000 EUR x 4.30
    expectD(portfolioRealizedPnlBase(valued), "100");
    expect(snapshot.warnings.filter((w) => w.kind === "realized_currency_mismatch")).toHaveLength(
      1,
    );
  });

  function r13History(fund: Instrument, transferred: Instrument | null = null): Transaction[] {
    const txns = [
      deposit("2026-01-02", "1000", { createdAt: at(2026, 1, 2) }),
      buildTxn(ACCOUNT, fund.id, { createdAt: at(2026, 1, 5) }), // 10 @ 100
      // reconciliation adds 2 units at the broker's average cost
      buildTxn(ACCOUNT, fund.id, {
        type: TxnType.ADJUSTMENT,
        tradeDate: "2026-09-30",
        quantity: "2",
        price: "75",
        grossAmount: "0",
        cashAmount: "0",
        source: TxnSource.RECONCILIATION,
        createdAt: at(2026, 9, 30),
      }),
    ];
    if (transferred !== null) {
      txns.push(
        buildTxn(ACCOUNT, transferred.id, {
          type: TxnType.TRANSFER_IN,
          tradeDate: "2026-02-01",
          quantity: "5",
          price: "80",
          grossAmount: "0",
          cashAmount: "0",
          createdAt: at(2026, 2, 1),
        }),
      );
    }
    return txns;
  }

  // test_r13_the_fallback_is_the_last_market_trade_not_the_reconciliation_cost
  it("r13 the fallback is the last market trade not the reconciliation cost", () => {
    const fund = instrument(null, {
      name: "Bond fund",
      symbol: "FND",
      mic: null,
      assetClass: AssetClass.FUND,
    });
    const { valued } = run(r13History(fund), [fund]);
    const h = holdingOf(valued, "FND");
    expectD(h.price, "100");
    expect([h.priceDate, h.isStale]).toEqual(["2026-01-05", true]);
    expectD(h.marketValueBase, "1200"); // 12 x 100, not 12 x 75 = 900
    expectD(h.costBasisBase, "1150"); // 1000 + 2 x 75
  });

  // test_r13_a_transfer_in_value_is_no_price
  it("r13 a transfer in value is no price", () => {
    const fund = instrument(null, {
      name: "Bond fund",
      symbol: "FND",
      mic: null,
      assetClass: AssetClass.FUND,
    });
    const other = instrument(null, {
      name: "Other fund",
      symbol: "OTH",
      mic: null,
      assetClass: AssetClass.FUND,
    });
    const { valued } = run(r13History(fund, other), [fund, other]);
    const h = holdingOf(valued, "OTH");
    expect([h.price, h.marketValueBase]).toEqual([null, null]);
    expectWarningIn(
      missingPrice({ instrumentId: asInstrumentId(other.id), asOf: AS_OF }),
      valued.warnings,
    );
  });

  // test_r15_the_price_currency_is_the_instruments_not_the_lots
  it("r15 the price currency is the instruments not the lots", () => {
    const eurEtf = instrument(null, {
      name: "EUR ETF",
      symbol: "EXX",
      mic: "XETR",
      currency: EUR,
    });
    const txns = [
      deposit("2026-09-01", "1000"),
      buildTxn(ACCOUNT, eurEtf.id, { tradeDate: "2026-09-02", quantity: "2", price: "400" }),
    ];
    const { valued } = run(
      txns,
      [eurEtf],
      [priceBar({ instrumentId: eurEtf.id, date: AS_OF, close: d("112.4"), source: "test" })],
      dailyRates(EUR, "2026-09-01", AS_OF, "4.25"),
    );
    const h = holdingOf(valued, "EXX");
    expectD(h.price, "112.4");
    expect([h.priceCurrency, h.holding.currency]).toEqual([EUR, PLN]);
    expectD(h.marketValueBase, "955.400");
  });
});
