/**
 * Investments domain contract: currency and money, wire enums, instrument and transaction rules,
 * holding and realized-trade getters. Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { D, DecimalError } from "../../decimal.js";
import * as domain from "./index.js";
import {
  ACCOUNT_WRAPPERS,
  AccountWrapper,
  AliasNamespace,
  ASSET_CLASSES,
  AssetClass,
  aliasOf,
  aliasToString,
  asAccountId,
  asInstrumentId,
  asProfileId,
  asTxnId,
  Currencies,
  cashBalance,
  compareChronological,
  countedBase,
  DECISION_ACTIONS,
  DEFAULT_MAX_FX_AGE_DAYS,
  DecisionAction,
  defaultValuationMode,
  dividedBy,
  fetchesMarketData,
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
  Money,
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
  VALUATION_MODES,
  ValuationMode,
  valuedCash,
  valuedPortfolio,
  valuedRealizedTrade,
  warningMessage,
} from "./index.js";

const d = D;
const iid = asInstrumentId;
const aid = asAccountId;
const tid = asTxnId;
const { PLN, USD, EUR } = Currencies;

/** Python `__all__` name -> the TS export that carries it (functions for properties are elsewhere). */

describe("investments domain contract", () => {
  // --- currency, money, decimals ----------------------------------------------------------------

  it("currency normalizes and validates ISO codes", () => {
    expect(toCurrency(" usd ")).toBe(USD);
    expect(PLN).toBe("PLN");
    // a branded string: works as a key next to plain codes
    expect(new Map<string, number>([[toCurrency("eur"), 1]]).get("EUR")).toBe(1);
    for (const bad of ["US", "US1", "", "EURO"]) {
      expect(() => toCurrency(bad)).toThrow(/ISO 4217/);
    }
  });

  it("money adds within one currency and refuses to mix", () => {
    const total = new Money(d("10.50"), PLN).add(new Money(d("0.5"), PLN));
    expect(sameMoney(total, new Money(d("11"), PLN))).toBe(true);
    expect(total.neg().amount.eq(d("-11"))).toBe(true);
    expect(total.sub(new Money(d("1"), PLN)).amount.eq(d("10"))).toBe(true);
    expect(Money.zero(EUR).amount.isZero()).toBe(true);
    expect(total.toString()).toBe("11.00 PLN");
    expect(() => total.add(new Money(d("1"), USD))).toThrow(/Currency mismatch/);
  });

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
  });

  it("instrument defaults: valuation mode by asset class, explicit mode wins", () => {
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

  it("transaction defaults and value equality", () => {
    const a = txn("t1");
    const b = txn("t1");
    expect(a).toEqual(b);
    expect([a.fee.isZero(), a.tax.isZero(), a.source]).toEqual([true, true, TxnSource.IMPORT]);
    expect(transaction({ ...a, type: TxnType.SELL })).not.toEqual(a);
    expect(() => txn("t2", undefined, null, { quantity: d("-1") })).toThrow(InvariantError);
    expect(() => txn("t3", undefined, null, { grossAmount: d("-1") })).toThrow(InvariantError);
  });

  it("chronological order: trade date, createdAt, then id", () => {
    const t0 = "2026-01-01T10:00:00+00:00";
    const late = txn("a", "2026-01-06", t0);
    const second = txn("b", undefined, "2026-01-01T10:00:00.000001+00:00");
    const first = txn("c", undefined, t0);
    const firstTie = txn("d", undefined, t0);
    const ordered = [late, second, firstTie, first].sort(compareChronological);
    expect(ordered.map((t) => t.id)).toEqual(["c", "d", "b", "a"]);
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
  });

  it("uncounted cash counts as zero and one unknown realized result makes the base sum unknown", () => {
    const negative = valuedCash({
      cash: cashBalance({ accountId: aid("a"), currency: PLN, amount: d("-5") }),
      amountBase: d("-5"),
    });
    const noRate = valuedCash({
      cash: cashBalance({ accountId: aid("a"), currency: USD, amount: d("5") }),
    });
    expect([countedBase(negative).isZero(), countedBase(noRate).isZero()]).toEqual([true, true]);
    // the getters never read the trade
    const anyTrade = null as unknown as RealizedTrade;
    const known = valuedRealizedTrade({ trade: anyTrade, proceedsBase: d("5"), costBase: d("3") });
    expect(domain.realizedPnlBase(known)?.eq(d("2"))).toBe(true);
    const portfolio = valuedPortfolio({
      snapshot: portfolioSnapshot({ profileId: asProfileId("p"), asOf: "2026-01-01" }),
      baseCurrency: PLN,
      cashBase: d("0"),
      totalBase: d("0"),
      staleWeight: 0.0,
      realized: [known, valuedRealizedTrade({ trade: anyTrade, proceedsBase: d("5") })],
    });
    expect(portfolioRealizedPnlBase(portfolio)).toBeNull();
  });
});
