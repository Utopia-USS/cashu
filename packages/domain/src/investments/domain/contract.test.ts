/**
 * Test-for-test translation of `tests/investments/domain/test_inv_domain_contract.py` (domain contract:
 * value types, enums, models and portfolio shapes). Synthetic data only. Each `it` names its Python
 * test in a comment.
 */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { D, DecimalError } from "../../decimal.js";
import * as domain from "./index.js";
import {
  ACCOUNT_WRAPPERS,
  AccountWrapper,
  ALL_WARNING_KINDS,
  AliasNamespace,
  ASSET_CLASSES,
  AssetClass,
  aliasOf,
  aliasToString,
  allocationOf,
  allocationPlan,
  allocationResult,
  asAccountId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  bucketAllocation,
  bucketDef,
  bucketMatch,
  bucketMatchIsEmpty,
  Currencies,
  cashBalance,
  cashHistoryGap,
  compareChronological,
  countedBase,
  DECISION_ACTIONS,
  DEFAULT_MAX_FX_AGE_DAYS,
  DecisionAction,
  dedupeWarnings,
  defaultValuationMode,
  dividedBy,
  fetchesMarketData,
  fxQuote,
  fxQuoteAgeDays,
  historyGap,
  holding,
  holdingAverageCost,
  holdingCostBasis,
  holdingHasMixedCurrencies,
  holdingHasUnknownCost,
  INSTRUMENT_STATUSES,
  type Instrument,
  type InstrumentInit,
  InstrumentStatus,
  InvariantError,
  instrument,
  instrumentAlias,
  instrumentLabel,
  instrumentRename,
  Money,
  manualValuation,
  marketView,
  missingInstrument,
  missingPrice,
  type OpenLot,
  openLot,
  parseAccountWrapper,
  parseAssetClass,
  parseDecisionAction,
  parseInstrumentStatus,
  parseSignalSeverity,
  parseSignalStatus,
  parseTxnSource,
  parseTxnType,
  parseValuationMode,
  placeholderInstrument,
  portfolioRealizedPnlBase,
  portfolioSnapshot,
  priceBar,
  type RealizedTrade,
  realizedCost,
  realizedHoldingDays,
  realizedProceeds,
  realizedTrade,
  SIGNAL_SEVERITIES,
  SIGNAL_STATUSES,
  SignalSeverity,
  SignalStatus,
  sameMoney,
  severityRank,
  type Transaction,
  type TransactionInit,
  TXN_SOURCES,
  TXN_TYPES,
  TxnSource,
  TxnType,
  toCurrency,
  transaction,
  unclassifiedWeight,
  VALUATION_MODES,
  ValuationMode,
  valuedAtCost,
  valuedCash,
  valuedHolding,
  valuedManually,
  valuedPortfolio,
  valuedRealizedTrade,
  viewInstrument,
  viewLastBar,
  viewLastBars,
  viewManualValuation,
  viewSeries,
  warningMessage,
} from "./index.js";

const d = D;
const iid = asInstrumentId;
const aid = asAccountId;
const tid = asTxnId;
const { PLN, USD, EUR } = Currencies;

/** Python `__all__` name -> the TS export that carries it (functions for properties are elsewhere). */
const PYTHON_ALL: Readonly<Record<string, keyof typeof domain>> = {
  ALL_WARNING_TYPES: "ALL_WARNING_KINDS",
  BUY_PLANS: "BUY_PLANS",
  DEFAULT_MAX_FX_AGE_DAYS: "DEFAULT_MAX_FX_AGE_DAYS",
  DIVISION_SCALE: "DIVISION_SCALE",
  EPOCH: "EPOCH",
  EXACT_CONTEXT: "EXACT_CONTEXT",
  GENERIC_BUCKET_IDS: "GENERIC_BUCKET_IDS",
  HELD_ONLY_PLANS: "HELD_ONLY_PLANS",
  PLAN_LABEL_HELD: "PLAN_LABEL_HELD",
  PLAN_LABEL_WATCHED: "PLAN_LABEL_WATCHED",
  PLAN_VALUES: "PLAN_VALUES",
  AccountId: "asAccountId",
  AccountWrapper: "AccountWrapper",
  AliasNamespace: "AliasNamespace",
  AllocationPlan: "allocationPlan",
  AllocationResult: "allocationResult",
  AssetClass: "AssetClass",
  BucketAllocation: "bucketAllocation",
  BucketDef: "bucketDef",
  BucketMatch: "bucketMatch",
  CalendarDate: "daysBetween",
  CashBalance: "cashBalance",
  CashHistoryGap: "cashHistoryGap",
  Currency: "toCurrency",
  DatedAmount: "datedAmount",
  DatedPrice: "datedPrice",
  DecisionAction: "DecisionAction",
  FrozenValuedAtZero: "frozenValuedAtZero",
  FxLookup: "fxQuote",
  FxQuote: "fxQuote",
  FxRate: "fxRate",
  HistoryGap: "historyGap",
  Holding: "holding",
  ImportBatchId: "asImportBatchId",
  Instrument: "instrument",
  InstrumentAlias: "instrumentAlias",
  InstrumentId: "asInstrumentId",
  InstrumentRename: "instrumentRename",
  InstrumentStatus: "InstrumentStatus",
  InvalidTransaction: "invalidTransaction",
  LastKnownPriceUsed: "lastKnownPriceUsed",
  ManualValuation: "manualValuation",
  MarketView: "marketView",
  MissingCostBasis: "missingCostBasis",
  MissingFxRate: "missingFxRate",
  MissingInstrument: "missingInstrument",
  MissingManualValuation: "missingManualValuation",
  MissingPrice: "missingPrice",
  MixedLotCurrencies: "mixedLotCurrencies",
  Money: "Money",
  OpenLot: "openLot",
  PortfolioSnapshot: "portfolioSnapshot",
  PortfolioWarning: "warningMessage",
  PriceBar: "priceBar",
  ProfileId: "asProfileId",
  RealizedCurrencyMismatch: "realizedCurrencyMismatch",
  RealizedTrade: "realizedTrade",
  SignalSeverity: "SignalSeverity",
  SignalStatus: "SignalStatus",
  StaleFxRate: "staleFxRate",
  StalePrice: "stalePrice",
  Transaction: "transaction",
  TxnId: "asTxnId",
  TxnSource: "TxnSource",
  TxnType: "TxnType",
  UnknownCostBasis: "unknownCostBasis",
  ValuationMode: "ValuationMode",
  ValuedCash: "valuedCash",
  ValuedHolding: "valuedHolding",
  ValuedPortfolio: "valuedPortfolio",
  ValuedRealizedTrade: "valuedRealizedTrade",
  chronological_key: "chronologicalKey",
  days_between: "daysBetween",
  default_valuation_mode: "defaultValuationMode",
  divided_by: "dividedBy",
  effective_plan: "effectivePlan",
  exact: "exact",
  exact_decimals: "exactDecimals",
  is_generic_bucket: "isGenericBucket",
  is_plan: "isPlan",
  opened_on: "openedOn",
  placeholder_instrument: "placeholderInstrument",
  plan_label: "planLabel",
  ratio: "ratio",
  severity_rank: "severityRank",
};

describe("investments domain contract", () => {
  // test_every_exported_name_resolves
  it("every exported name resolves", () => {
    expect(Object.keys(PYTHON_ALL)).toHaveLength(85);
    for (const [pyName, tsName] of Object.entries(PYTHON_ALL)) {
      // biome-ignore lint/performance/noDynamicNamespaceImportAccess: the test enumerates the exports
      expect(domain[tsName], pyName).toBeDefined();
    }
    for (const [name, value] of Object.entries(domain)) {
      expect(value, name).not.toBeUndefined();
    }
  });

  // --- currency, money, decimals ----------------------------------------------------------------

  // test_currency_normalizes_and_validates_iso_codes
  it("currency normalizes and validates ISO codes", () => {
    expect(toCurrency(" usd ")).toBe(USD);
    expect(PLN).toBe("PLN");
    // a branded string: works as a key next to plain codes
    expect(new Map<string, number>([[toCurrency("eur"), 1]]).get("EUR")).toBe(1);
    for (const bad of ["US", "US1", "", "EURO"]) {
      expect(() => toCurrency(bad)).toThrow(/ISO 4217/);
    }
  });

  // test_money_adds_within_one_currency_and_refuses_to_mix
  it("money adds within one currency and refuses to mix", () => {
    const total = new Money(d("10.50"), PLN).add(new Money(d("0.5"), PLN));
    expect(sameMoney(total, new Money(d("11"), PLN))).toBe(true);
    expect(total.neg().amount.eq(d("-11"))).toBe(true);
    expect(total.sub(new Money(d("1"), PLN)).amount.eq(d("10"))).toBe(true);
    expect(Money.zero(EUR).amount.isZero()).toBe(true);
    expect(total.toString()).toBe("11.00 PLN");
    expect(() => total.add(new Money(d("1"), USD))).toThrow(/Currency mismatch/);
  });

  // test_divided_by_rounds_half_up_to_the_requested_scale
  it("dividedBy rounds half-up to the requested scale", () => {
    expect(dividedBy(d("32"), d("3")).toString()).toBe("10.6666666667");
    expect(dividedBy(d("2"), d("3"), 2).toString()).toBe("0.67");
    expect(dividedBy(d("1"), d("8"), 2).toString()).toBe("0.13"); // tie away from zero
    expect(dividedBy(d("-1"), d("8"), 2).toString()).toBe("-0.13");
    expect(dividedBy(d("-1"), d("3"), 4).toString()).toBe("-0.3333");
    expect(dividedBy(d("10"), d("4")).eq(d("2.5"))).toBe(true);
    expect(() => dividedBy(d("1"), d("0"))).toThrow(DecimalError);
  });

  // --- enums ------------------------------------------------------------------------------------

  // test_enum_values_are_snake_case_wire_names_and_round_trip
  it("enum values are snake_case wire names and round-trip", () => {
    expect(TxnType.FX_CONVERSION).toBe("fx_conversion");
    expect(parseAssetClass("treasury_bond")).toBe(AssetClass.TREASURY_BOND);
    expect(TxnType.TRANSFER_IN).toBe("transfer_in");
    expect(() => parseTxnType("transferIn")).toThrow(InvariantError);
    const enums: ReadonlyArray<
      readonly [Readonly<Record<string, string>>, readonly string[], (v: string) => string]
    > = [
      [AccountWrapper, ACCOUNT_WRAPPERS, parseAccountWrapper],
      [AssetClass, ASSET_CLASSES, parseAssetClass],
      [TxnType, TXN_TYPES, parseTxnType],
      [TxnSource, TXN_SOURCES, parseTxnSource],
      [ValuationMode, VALUATION_MODES, parseValuationMode],
      [InstrumentStatus, INSTRUMENT_STATUSES, parseInstrumentStatus],
      [SignalSeverity, SIGNAL_SEVERITIES, parseSignalSeverity],
      [SignalStatus, SIGNAL_STATUSES, parseSignalStatus],
      [DecisionAction, DECISION_ACTIONS, parseDecisionAction],
    ];
    for (const [members, values, parse] of enums) {
      expect(values).toEqual(Object.values(members));
      for (const [name, value] of Object.entries(members)) {
        expect(parse(value)).toBe(value);
        expect(value).toBe(value.toLowerCase());
        expect(name.toLowerCase()).toBe(value);
      }
    }
  });

  // test_stage_2_enum_additions
  it("stage 2 enum additions", () => {
    expect(AssetClass.CLAIM).toBe("claim");
    expect(VALUATION_MODES).toEqual(["market", "cost", "manual"]);
    expect(INSTRUMENT_STATUSES).toEqual(["active", "delisted", "frozen"]);
  });

  // test_default_valuation_modes_and_severity_order
  it("default valuation modes and severity order", () => {
    expect(defaultValuationMode(AssetClass.TREASURY_BOND)).toBe(ValuationMode.COST);
    expect(defaultValuationMode(AssetClass.CLAIM)).toBe(ValuationMode.MANUAL);
    expect(defaultValuationMode(AssetClass.ETF)).toBe(ValuationMode.MARKET);
    expect(severityRank(SignalSeverity.INFO)).toBeLessThan(severityRank(SignalSeverity.ACTION));
    expect(DEFAULT_MAX_FX_AGE_DAYS).toBe(10);
  });

  // --- models -----------------------------------------------------------------------------------

  function inst(overrides: Partial<InstrumentInit> = {}): Instrument {
    return instrument({
      id: iid("i1"),
      name: "Orlen",
      currency: PLN,
      assetClass: AssetClass.EQUITY,
      ...overrides,
    });
  }

  // test_instrument_alias_prefers_a_confirmed_alias_over_a_guess
  it("instrument alias prefers a confirmed alias over a guess", () => {
    const pkn = inst({
      aliases: [
        instrumentAlias(AliasNamespace.STOOQ, "pkn_guess", true),
        instrumentAlias(AliasNamespace.STOOQ, "pkn"),
        instrumentAlias(AliasNamespace.YAHOO, "PKN.WA", true),
      ],
    });
    expect(aliasOf(pkn, AliasNamespace.STOOQ)).toBe("pkn");
    expect(aliasOf(pkn, AliasNamespace.YAHOO)).toBe("PKN.WA");
    expect(aliasOf(pkn, AliasNamespace.ISIN)).toBeNull();
    expect(aliasToString(pkn.aliases[0] as domain.InstrumentAlias)).toBe(
      "stooq:pkn_guess (guessed)",
    );
    expect(Object.isFrozen(pkn.aliases)).toBe(true); // lists are frozen (Python: into tuples)
  });

  // test_instrument_defaults_and_immutability
  it("instrument defaults and immutability", () => {
    const pkn = inst({ tags: ["pl"] });
    expect(pkn.valuationMode).toBe(ValuationMode.MARKET);
    expect(pkn.status).toBe(InstrumentStatus.ACTIVE);
    expect(fetchesMarketData(pkn)).toBe(true);
    expect(pkn.tags).toEqual(["pl"]);
    expect(instrumentLabel(pkn)).toBe("Orlen");
    expect(instrumentLabel(inst({ symbol: "PKN" }))).toBe("PKN");
    expect(inst({ assetClass: AssetClass.TREASURY_BOND }).valuationMode).toBe(ValuationMode.COST);
    // An explicit mode wins over the asset-class default and survives a copy with changes.
    const explicit = inst({
      assetClass: AssetClass.TREASURY_BOND,
      valuationMode: ValuationMode.MANUAL,
    });
    expect(instrument({ ...explicit, name: "EDO" }).valuationMode).toBe(ValuationMode.MANUAL);
    expect(fetchesMarketData(inst({ status: InstrumentStatus.DELISTED }))).toBe(false);
    expect(() => {
      // @ts-expect-error readonly: the runtime object is frozen too
      pkn.name = "x";
    }).toThrow(TypeError);
    const placeholder = placeholderInstrument(iid("x"), USD);
    expect([placeholder.assetClass, placeholder.needsClassification]).toEqual([
      AssetClass.OTHER,
      true,
    ]);
  });

  function txn(
    id: string,
    tradeDate = "2026-01-05",
    createdAt: string | null = null,
    overrides: Partial<TransactionInit> = {},
  ): Transaction {
    return transaction({
      id: tid(id),
      accountId: aid("a"),
      type: TxnType.BUY,
      tradeDate,
      currency: PLN,
      grossAmount: d("1000"),
      cashAmount: d("-1000"),
      cashCurrency: PLN,
      instrumentId: iid("i1"),
      quantity: d("10"),
      price: d("100"),
      ...(createdAt === null ? {} : { createdAt: parseDateTime(createdAt) }),
      ...overrides,
    });
  }

  // test_transaction_defaults_and_value_equality
  it("transaction defaults and value equality", () => {
    const a = txn("t1");
    const b = txn("t1");
    expect(a).toEqual(b);
    expect([a.fee.isZero(), a.tax.isZero(), a.source]).toEqual([true, true, TxnSource.IMPORT]);
    expect(transaction({ ...a, type: TxnType.SELL })).not.toEqual(a);
    expect(() => txn("t2", undefined, null, { quantity: d("-1") })).toThrow(InvariantError);
    expect(() => txn("t3", undefined, null, { grossAmount: d("-1") })).toThrow(InvariantError);
  });

  // test_chronological_key_orders_by_trade_date_created_at_then_id
  it("chronological order: trade date, createdAt, then id", () => {
    const t0 = "2026-01-01T10:00:00+00:00";
    const late = txn("a", "2026-01-06", t0);
    const second = txn("b", undefined, "2026-01-01T10:00:00.000001+00:00");
    const first = txn("c", undefined, t0);
    const firstTie = txn("d", undefined, t0);
    const ordered = [late, second, firstTie, first].sort(compareChronological);
    expect(ordered.map((t) => t.id)).toEqual(["c", "d", "b", "a"]);
  });

  // test_stage_2_reference_types
  it("stage 2 reference types", () => {
    const valuation = manualValuation({
      instrumentId: iid("i1"),
      asOf: "2026-01-01",
      unitValue: d("0"),
      currency: USD,
    });
    expect(valuation.unitValue.isZero()).toBe(true);
    const rename = instrumentRename({
      date: "2026-02-01",
      oldInstrumentId: iid("old"),
      newInstrumentId: iid("new"),
    });
    expect([rename.oldInstrumentId, rename.newInstrumentId]).toEqual(["old", "new"]);
  });

  // --- portfolio shapes -------------------------------------------------------------------------

  function lot(quantity: string, cost: string | null, currency = PLN): OpenLot {
    return openLot({
      accountId: aid("a"),
      instrumentId: iid("i"),
      openTxnId: tid("t"),
      openDate: "2026-01-05",
      quantity: d(quantity),
      unitCost: cost === null ? null : d(cost),
      currency,
    });
  }

  function hold(quantity: string, lots: readonly OpenLot[], currency = PLN) {
    return holding({
      accountId: aid("a"),
      instrumentId: iid("i"),
      currency,
      quantity: d(quantity),
      lots,
    });
  }

  // test_holding_getters_sum_lot_costs_and_flag_unknown_or_mixed_costs
  it("holding getters sum lot costs and flag unknown or mixed costs", () => {
    const known = hold("3", [lot("1", "10"), lot("2", "11")]);
    const unknown = hold("1", [lot("1", null)]);
    const mixed = hold("2", [lot("1", "10"), lot("1", "3", USD)]);
    expect(holdingCostBasis(known)?.toString()).toBe("32");
    expect(holdingAverageCost(known)?.toString()).toBe("10.6666666667");
    expect(holdingHasUnknownCost(known)).toBe(false);
    expect([holdingCostBasis(unknown), holdingAverageCost(unknown)]).toEqual([null, null]);
    expect(holdingHasUnknownCost(unknown)).toBe(true);
    expect(holdingHasMixedCurrencies(mixed)).toBe(true);
    expect([holdingCostBasis(mixed), holdingAverageCost(mixed)]).toEqual([null, null]);
  });

  // test_market_view_window_getters_and_manual_valuations
  it("market view window getters and manual valuations", () => {
    const bars = [1, 2, 3, 4, 5].map((n) =>
      priceBar({
        instrumentId: iid("i"),
        date: `2026-01-0${n}`,
        close: D(BigInt(n)),
        source: "stooq",
      }),
    );
    const mv = (asOf: string, unitValue: string) =>
      manualValuation({ instrumentId: iid("i"), asOf, unitValue: d(unitValue), currency: PLN });
    const view = marketView({
      asOf: "2026-01-05",
      bars: new Map([[iid("i"), bars]]),
      manualValuations: new Map([
        [iid("i"), [mv("2025-12-01", "1"), mv("2026-01-03", "2"), mv("2026-02-01", "3")]],
      ]),
    });
    expect(viewLastBar(view, iid("i"))?.close.toString()).toBe("5");
    expect(viewLastBars(view, iid("i"), 2).map((b) => b.close.toString())).toEqual(["4", "5"]);
    expect(viewLastBars(view, iid("i"), 10)).toHaveLength(5);
    expect(viewSeries(view, iid("none"))).toEqual([]);
    expect(viewLastBar(view, iid("none"))).toBeNull();
    expect(viewManualValuation(view, iid("i"))?.unitValue.toString()).toBe("2");
    expect(viewManualValuation(view, iid("i"), "2026-03-01")?.unitValue.toString()).toBe("3");
    expect(viewManualValuation(view, iid("i"), "2025-01-01")).toBeNull();
    expect(viewInstrument(view, iid("none"))).toBeNull();
  });

  // test_realized_trade_getters_and_history_gap_message
  it("realized trade getters and history gap message", () => {
    const trade = realizedTrade({
      accountId: aid("a"),
      instrumentId: iid("i"),
      openTxnId: tid("o"),
      closeTxnId: tid("c"),
      openDate: "2025-01-01",
      closeDate: "2026-01-01",
      quantity: d("2"),
      closeUnitPrice: d("12"),
      openUnitCost: d("10"),
      pnl: d("4"),
      currency: PLN,
    });
    const gap = historyGap({
      accountId: aid("a"),
      instrumentId: iid("i"),
      date: "2026-01-01",
      shortfall: d("3"),
      txnId: tid("c"),
    });
    expect(realizedHoldingDays(trade)).toBe(365);
    expect(trade.costCurrency).toBe(PLN); // defaults to the sale currency
    expect([realizedProceeds(trade).toString(), realizedCost(trade)?.toString()]).toEqual([
      "24",
      "20",
    ]);
    expect(warningMessage(gap)).toContain("needs 3 more units");
    // Python `str(gap) == gap.message`: TS has one function for both.
  });

  // test_warnings_have_unique_kinds_value_equality_and_account_scope
  it("warnings have unique kinds, value equality and account scope", () => {
    expect(new Set(ALL_WARNING_KINDS).size).toBe(ALL_WARNING_KINDS.length);
    // issubclass(w, PortfolioWarning): the union is closed, `warningMessage` is exhaustive over it.
    const gap = cashHistoryGap({
      accountId: aid("a"),
      currency: PLN,
      amount: d("-1"),
      asOf: "2026-01-01",
    });
    expect(gap.accountId).toBe("a");
    expect(missingInstrument({ instrumentId: iid("i") }).accountId).toBeNull();
    const price = () => missingPrice({ instrumentId: iid("i"), asOf: "2026-01-01" });
    expect(price()).toEqual(price());
    expect(dedupeWarnings([price(), price()])).toHaveLength(1);
  });

  // test_valued_shapes_getters
  it("valued shapes getters", () => {
    const h = hold("1", [lot("1", "10")]);
    const valued = valuedHolding({
      holding: h,
      instrument: inst({ id: iid("i") }),
      isStale: false,
      valuationMode: ValuationMode.COST,
    });
    expect([valued.holding.accountId, valued.holding.instrumentId]).toEqual(["a", "i"]);
    expect([valuedAtCost(valued), valuedManually(valued)]).toEqual([true, false]);
    const negative = valuedCash({
      cash: cashBalance({ accountId: aid("a"), currency: PLN, amount: d("-5") }),
      amountBase: d("-5"),
    });
    const noRate = valuedCash({
      cash: cashBalance({ accountId: aid("a"), currency: USD, amount: d("5") }),
    });
    expect([countedBase(negative).isZero(), countedBase(noRate).isZero()]).toEqual([true, true]);
    // Python passes trade=None here; the getter never reads the trade.
    const anyTrade = null as unknown as RealizedTrade;
    expect(
      domain
        .realizedPnlBase(
          valuedRealizedTrade({ trade: anyTrade, proceedsBase: d("5"), costBase: d("3") }),
        )
        ?.eq(d("2")),
    ).toBe(true);
    const snapshot = portfolioSnapshot({ profileId: asProfileId("p"), asOf: "2026-01-01" });
    const portfolio = valuedPortfolio({
      snapshot,
      baseCurrency: PLN,
      cashBase: d("0"),
      totalBase: d("0"),
      staleWeight: 0.0,
      realized: [valuedRealizedTrade({ trade: anyTrade, proceedsBase: d("5") })],
    });
    expect([portfolio.snapshot.profileId, portfolio.snapshot.asOf]).toEqual(["p", "2026-01-01"]);
    expect(portfolioRealizedPnlBase(portfolio)).toBeNull(); // one unknown result makes the sum unknown
    expect(fxQuoteAgeDays(fxQuote(d("4"), "2026-01-02"), "2026-01-12")).toBe(10);
  });

  // test_bucket_contract_normalizes_sets_and_allocation_result_helpers
  it("bucket contract normalizes sets and allocation result helpers", () => {
    const match = bucketMatch({ assetClasses: [AssetClass.ETF], tags: ["global_equity"] });
    expect(match.assetClasses).toEqual(new Set([AssetClass.ETF]));
    expect(bucketMatchIsEmpty(match)).toBe(false);
    expect(bucketMatchIsEmpty(bucketMatch())).toBe(true);
    const plan = allocationPlan({ buckets: [bucketDef({ id: "x", match })], targets: { x: 1.0 } });
    expect(Object.isFrozen(plan.buckets)).toBe(true);
    expect(plan.targets.get("x")).toBe(1.0);
    expect(bucketMatchIsEmpty(bucketDef({ id: "all" }).match)).toBe(true);
    const allocation = bucketAllocation({
      bucketId: "x",
      weight: 0.5,
      target: 1.0,
      driftPp: -50.0,
      driftRel: -0.5,
      valueBase: d("50"),
      driftValueBase: d("-50"),
    });
    const result = allocationResult({
      totalBase: d("100"),
      unclassifiedValueBase: d("25"),
      unallocatedCashBase: d("0"),
      allocations: [allocation],
    });
    expect(unclassifiedWeight(result)).toBe(0.25);
    expect(allocationOf(result, "x")).toBe(allocation);
    expect(
      unclassifiedWeight(
        allocationResult({
          totalBase: d("0"),
          unclassifiedValueBase: d("0"),
          unallocatedCashBase: d("0"),
        }),
      ),
    ).toBe(0);
  });
});
