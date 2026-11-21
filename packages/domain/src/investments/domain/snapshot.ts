/**
 * Portfolio data shapes (`investments/domain/snapshot.py`) shared by the portfolio math, the rules
 * engine and the daily run.
 *
 * Plain frozen data; Python's properties are the pure functions below (`holdingCostBasis(h)` for
 * `h.cost_basis`). Trivial delegating properties are field paths: `ValuedHolding.account_id` is
 * `v.holding.accountId`, `instrument_id` is `v.holding.instrumentId`, `ValuedCash.account_id` /
 * `currency` are `c.cash.accountId` / `c.cash.currency`, `ValuedPortfolio.profile_id` / `as_of` are
 * `p.snapshot.profileId` / `p.snapshot.asOf`.
 *
 * Money amounts are `Decimal` and every sum / product runs in `EXACT_CONTEXT` (60 digits, half-up)
 * like the Python `_add` / `_mul`. Ratios and weights are JS numbers where Python uses float: values
 * from `ratio` are the correctly rounded double of a 40-digit decimal quotient, so they match Python
 * bit for bit (parity tolerance 0; the S03 default abs 1e-9 / rel 1e-12 applies only to floats
 * computed by later float arithmetic, e.g. drift).
 */

import { type Decimal, ZERO } from "../../decimal.js";
import { ValuationMode } from "./enums.js";
import type { Instrument, ManualValuation } from "./instrument.js";
import type { PriceBar } from "./marketData.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  daysBetween,
  dividedBy,
  EXACT_CONTEXT,
  type Init,
  type InstrumentId,
  type Money,
  type ProfileId,
  ratio,
  type TxnId,
  withDefaults,
} from "./values.js";
import type { PortfolioWarning } from "./warnings.js";

const mul = (a: Decimal, b: Decimal): Decimal => a.mul(b, EXACT_CONTEXT);
const add = (a: Decimal, b: Decimal): Decimal => a.add(b, EXACT_CONTEXT);
const sub = (a: Decimal, b: Decimal): Decimal => a.sub(b, EXACT_CONTEXT);

// --- lots, trades, holdings ---------------------------------------------------------------------

/** A still-open FIFO lot of one instrument in one account. */
export interface OpenLot {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  /** Transaction that opened the lot (buy, transfer in, adjustment). */
  readonly openTxnId: TxnId;
  readonly openDate: CalendarDate;
  /** Remaining units (after partial sells and splits), > 0. */
  readonly quantity: Decimal;
  readonly currency: Currency;
  /** Cost per unit in `currency` including buy fees; null when unknown (transfer in without price). */
  readonly unitCost: Decimal | null;
}

export function openLot(init: Init<OpenLot, "unitCost">): OpenLot {
  return withDefaults<OpenLot>({ unitCost: null }, init);
}

/** `OpenLot.cost_basis`: `quantity * unitCost`, or null when the cost is unknown. */
export function lotCostBasis(lot: OpenLot): Decimal | null {
  return lot.unitCost === null ? null : mul(lot.unitCost, lot.quantity);
}

/**
 * A closed (part of a) lot: one FIFO match between an opening and a closing transaction.
 *
 * The cost is in `costCurrency` (the lot's), the proceeds in `currency` (the sell's). When they
 * differ, `pnl` is null because two currencies are never subtracted; the base-currency result at
 * trade-date FX is `realizedPnlBase(ValuedRealizedTrade)`.
 */
export interface RealizedTrade {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  readonly openTxnId: TxnId;
  readonly closeTxnId: TxnId;
  readonly openDate: CalendarDate;
  readonly closeDate: CalendarDate;
  readonly quantity: Decimal;
  /** Proceeds per unit net of sell fees and taxes, in `currency`. */
  readonly closeUnitPrice: Decimal;
  readonly currency: Currency;
  /** Currency of the lot's cost; `realizedTrade()` defaults it to `currency`. */
  readonly costCurrency: Currency;
  /** Cost per unit incl. buy fees in `costCurrency`, null when unknown. */
  readonly openUnitCost: Decimal | null;
  /** Realized profit in `currency`; null when the cost is unknown or the currencies differ. */
  readonly pnl: Decimal | null;
}

export function realizedTrade(
  init: Omit<Init<RealizedTrade, "openUnitCost" | "pnl">, "costCurrency"> & {
    readonly costCurrency?: Currency | null;
  },
): RealizedTrade {
  const { costCurrency, ...rest } = init;
  return withDefaults<RealizedTrade>(
    { openUnitCost: null, pnl: null },
    { ...rest, costCurrency: costCurrency ?? init.currency },
  );
}

/** `RealizedTrade.holding_days`. */
export function realizedHoldingDays(trade: RealizedTrade): number {
  return daysBetween(trade.openDate, trade.closeDate);
}

/** `RealizedTrade.proceeds`: net proceeds of the matched units in `currency`. */
export function realizedProceeds(trade: RealizedTrade): Decimal {
  return mul(trade.closeUnitPrice, trade.quantity);
}

/** `RealizedTrade.cost`: cost of the matched units in `costCurrency`, null when unknown. */
export function realizedCost(trade: RealizedTrade): Decimal | null {
  return trade.openUnitCost === null ? null : mul(trade.openUnitCost, trade.quantity);
}

/** Position in one instrument in one account (sum of its open lots). */
export interface Holding {
  readonly accountId: AccountId;
  readonly instrumentId: InstrumentId;
  /** Currency of the lots' costs (the first lot's; normally the instrument's trading currency). */
  readonly currency: Currency;
  readonly quantity: Decimal;
  readonly lots: readonly OpenLot[];
}

export function holding(
  init: Omit<Holding, "lots"> & { readonly lots?: Iterable<OpenLot> },
): Holding {
  return Object.freeze({ ...init, lots: Object.freeze([...(init.lots ?? [])]) });
}

/** `Holding.has_unknown_cost`. */
export function holdingHasUnknownCost(h: Holding): boolean {
  return h.lots.some((lot) => lot.unitCost === null);
}

/** `Holding.has_mixed_currencies`. */
export function holdingHasMixedCurrencies(h: Holding): boolean {
  return h.lots.some((lot) => lot.currency !== h.currency);
}

/** `Holding.cost_basis`: sum of lot costs; null if any lot cost is unknown or the lots mix currencies. */
export function holdingCostBasis(h: Holding): Decimal | null {
  if (holdingHasMixedCurrencies(h)) return null;
  let total = ZERO;
  for (const lot of h.lots) {
    const cost = lotCostBasis(lot);
    if (cost === null) return null;
    total = add(total, cost);
  }
  return total;
}

/** `Holding.average_cost`: `costBasis / quantity` via `dividedBy`, null when unknown or quantity 0. */
export function holdingAverageCost(h: Holding): Decimal | null {
  const cost = holdingCostBasis(h);
  if (cost === null || h.quantity.isZero()) return null;
  return dividedBy(cost, h.quantity);
}

/** Cash of one account in one currency (sum of `Transaction.cashAmount`). */
export interface CashBalance {
  readonly accountId: AccountId;
  readonly currency: Currency;
  readonly amount: Decimal;
}

export function cashBalance(init: CashBalance): CashBalance {
  return Object.freeze({ ...init });
}

/** A dated cash amount in its own currency, e.g. one deposit. */
export interface DatedAmount {
  readonly accountId: AccountId;
  readonly date: CalendarDate;
  readonly amount: Money;
}

export function datedAmount(init: DatedAmount): DatedAmount {
  return Object.freeze({ ...init });
}

/** A unit price observed on a date (e.g. the last trade price of an instrument). */
export interface DatedPrice {
  readonly date: CalendarDate;
  readonly price: Decimal;
  readonly currency: Currency;
}

export function datedPrice(init: DatedPrice): DatedPrice {
  return Object.freeze({ ...init });
}

// --- snapshot -----------------------------------------------------------------------------------

/** Derived state of a profile as of a date (only transactions on/before `asOf`). */
export interface PortfolioSnapshot {
  readonly profileId: ProfileId;
  readonly asOf: CalendarDate;
  /** Non-zero positions, one per (account, instrument), in order of first appearance. */
  readonly holdings: readonly Holding[];
  readonly cash: readonly CashBalance[];
  /** Deposits, oldest first (input of `contribution_gap`). */
  readonly deposits: readonly DatedAmount[];
  readonly realized: readonly RealizedTrade[];
  /**
   * Newest positive buy/sell price per instrument on/before `asOf` (split-adjusted, reconciliation
   * rows ignored). Valuation falls back to it when an instrument has no market bar.
   */
  readonly lastTradePrices: ReadonlyMap<InstrumentId, DatedPrice>;
  readonly warnings: readonly PortfolioWarning[];
}

export function portfolioSnapshot(
  init: Init<
    PortfolioSnapshot,
    "holdings" | "cash" | "deposits" | "realized" | "lastTradePrices" | "warnings"
  >,
): PortfolioSnapshot {
  return withDefaults<PortfolioSnapshot>(
    {
      holdings: [],
      cash: [],
      deposits: [],
      realized: [],
      lastTradePrices: new Map(),
      warnings: [],
    },
    init,
  );
}

/** `PortfolioSnapshot.realized_pnl_by_currency`: only trades with a known cost in the sale currency. */
export function realizedPnlByCurrency(snapshot: PortfolioSnapshot): Map<Currency, Decimal> {
  const result = new Map<Currency, Decimal>();
  for (const trade of snapshot.realized) {
    if (trade.pnl === null) continue;
    result.set(trade.currency, add(result.get(trade.currency) ?? ZERO, trade.pnl));
  }
  return result;
}

/** `PortfolioSnapshot.holdings_of`: holdings of `instrumentId` across accounts. */
export function holdingsOf(snapshot: PortfolioSnapshot, instrumentId: InstrumentId): Holding[] {
  return snapshot.holdings.filter((h) => h.instrumentId === instrumentId);
}

// --- valued shapes ------------------------------------------------------------------------------

/**
 * A holding with price and base-currency values. Price-dependent fields are null when no price is
 * known (the holding is then excluded from weights and a warning is recorded).
 */
export interface ValuedHolding {
  readonly holding: Holding;
  readonly instrument: Instrument;
  /** Price older than the allowed age, last trade price used, or no price at all. */
  readonly isStale: boolean;
  /** Unit price used, in `priceCurrency` (the average unit cost when valued at cost). */
  readonly price: Decimal | null;
  /** Bar date, last trade date or manual valuation date; null at cost (and for a frozen default 0). */
  readonly priceDate: CalendarDate | null;
  readonly marketValueBase: Decimal | null;
  /** Cost in the base currency at trade-date FX; null when any lot cost or rate is unknown. */
  readonly costBasisBase: Decimal | null;
  /** Float: (marketValueBase - costBasisBase) / costBasisBase, e.g. -0.25 for a 25 % loss. */
  readonly unrealizedPct: number | null;
  /** Float: marketValueBase / ValuedPortfolio.totalBase, 0..1. */
  readonly weight: number | null;
  /** Mode actually used (a frozen instrument is valued manually whatever its configured mode). */
  readonly valuationMode: ValuationMode;
  /**
   * Instrument currency for bars, the last trade price's own currency, the manual valuation's
   * currency, the lots' currency at cost (the base currency when the lots mix currencies).
   */
  readonly priceCurrency: Currency | null;
  /**
   * Set when a price is known but no usable valuation-date rate converts `priceCurrency`:
   * `marketValueBase` and `weight` are then null.
   */
  readonly missingFxCurrency: Currency | null;
}

export function valuedHolding(
  init: Init<
    ValuedHolding,
    | "price"
    | "priceDate"
    | "marketValueBase"
    | "costBasisBase"
    | "unrealizedPct"
    | "weight"
    | "valuationMode"
    | "priceCurrency"
    | "missingFxCurrency"
  >,
): ValuedHolding {
  return withDefaults<ValuedHolding>(
    {
      price: null,
      priceDate: null,
      marketValueBase: null,
      costBasisBase: null,
      unrealizedPct: null,
      weight: null,
      valuationMode: ValuationMode.MARKET,
      priceCurrency: null,
      missingFxCurrency: null,
    },
    init,
  );
}

/** `ValuedHolding.valued_at_cost`: valued at its cost basis, never stale, no price date. */
export function valuedAtCost(v: ValuedHolding): boolean {
  return v.valuationMode === ValuationMode.COST;
}

/** `ValuedHolding.valued_manually`: from a manual valuation (or a frozen default 0), never stale. */
export function valuedManually(v: ValuedHolding): boolean {
  return v.valuationMode === ValuationMode.MANUAL;
}

/** One cash balance with its value in the base currency. */
export interface ValuedCash {
  readonly cash: CashBalance;
  /** Converted at the valuation-date rate (negative when the balance is); null without a usable rate. */
  readonly amountBase: Decimal | null;
}

export function valuedCash(init: Init<ValuedCash, "amountBase">): ValuedCash {
  return withDefaults<ValuedCash>({ amountBase: null }, init);
}

/**
 * `ValuedCash.counted_base`: what the balance contributes to totals and weights, `amountBase` floored
 * at 0 (a negative balance means deposits are missing, `CashHistoryGap`); 0 without a rate.
 */
export function countedBase(v: ValuedCash): Decimal {
  if (v.amountBase === null || v.amountBase.lt(ZERO)) return ZERO;
  return v.amountBase;
}

/**
 * A realized trade with its base-currency result: proceeds at the close-date rate, cost at the
 * open-date rate.
 */
export interface ValuedRealizedTrade {
  readonly trade: RealizedTrade;
  readonly proceedsBase: Decimal | null;
  readonly costBase: Decimal | null;
}

export function valuedRealizedTrade(
  init: Init<ValuedRealizedTrade, "proceedsBase" | "costBase">,
): ValuedRealizedTrade {
  return withDefaults<ValuedRealizedTrade>({ proceedsBase: null, costBase: null }, init);
}

/** `ValuedRealizedTrade.pnl_base`. */
export function realizedPnlBase(v: ValuedRealizedTrade): Decimal | null {
  if (v.proceedsBase === null || v.costBase === null) return null;
  return sub(v.proceedsBase, v.costBase);
}

/** A snapshot valued in the base currency. */
export interface ValuedPortfolio {
  readonly snapshot: PortfolioSnapshot;
  readonly baseCurrency: Currency;
  /** Cash counted in totals: balances with a usable rate, negative ones as 0 (sum of `countedBase`). */
  readonly cashBase: Decimal;
  /** Valued holdings' market values plus `cashBase`. */
  readonly totalBase: Decimal;
  /** Float: share of `totalBase` valued with stale prices, 0..1. */
  readonly staleWeight: number;
  readonly valued: readonly ValuedHolding[];
  /** Every cash balance in scope with its base value (allocation needs cash per account/currency). */
  readonly cash: readonly ValuedCash[];
  /** Valuation warnings (snapshot warnings stay on `snapshot`). */
  readonly warnings: readonly PortfolioWarning[];
  /**
   * Currencies without a usable valuation-date rate that a holding or cash balance needed: those
   * amounts are left out of `totalBase`, so weight rules skip.
   */
  readonly missingFxCurrencies: ReadonlySet<Currency>;
  readonly realized: readonly ValuedRealizedTrade[];
}

export function valuedPortfolio(
  init: Init<ValuedPortfolio, "valued" | "cash" | "warnings" | "missingFxCurrencies" | "realized">,
): ValuedPortfolio {
  return withDefaults<ValuedPortfolio>(
    { valued: [], cash: [], warnings: [], missingFxCurrencies: new Set(), realized: [] },
    init,
  );
}

/** `ValuedPortfolio.realized_pnl_base`: the sum, or null when any trade's result is unknown. */
export function portfolioRealizedPnlBase(p: ValuedPortfolio): Decimal | null {
  let total = ZERO;
  for (const trade of p.realized) {
    const pnl = realizedPnlBase(trade);
    if (pnl === null) return null;
    total = add(total, pnl);
  }
  return total;
}

/** `ValuedPortfolio.all_warnings`: snapshot warnings followed by valuation warnings. */
export function allWarnings(p: ValuedPortfolio): PortfolioWarning[] {
  return [...p.snapshot.warnings, ...p.warnings];
}

// --- allocation ---------------------------------------------------------------------------------

/** Allocation of one strategy bucket. Drift is `weight - target`: positive means overweight. */
export interface BucketAllocation {
  readonly bucketId: string;
  /** Float: current share of the portfolio total, 0..1. */
  readonly weight: number;
  readonly target: number;
  /** Float: (weight - target) * 100, in percentage points. */
  readonly driftPp: number;
  /** Float: (weight - target) / target; `Infinity` when target is 0 and weight > 0, 0 when both are 0. */
  readonly driftRel: number;
  readonly valueBase: Decimal;
  /** valueBase - target * total: positive = above target (to sell), negative = to buy. */
  readonly driftValueBase: Decimal;
  /** A negative cash balance (counted as 0) falls into this bucket: its real value is unknown. */
  readonly cashHistoryGap: boolean;
}

export function bucketAllocation(init: Init<BucketAllocation, "cashHistoryGap">): BucketAllocation {
  return withDefaults<BucketAllocation>({ cashHistoryGap: false }, init);
}

/** Output of `allocate`. */
export interface AllocationResult {
  /** Denominator of every bucket weight: valued holdings plus counted cash (classified or not). */
  readonly totalBase: Decimal;
  readonly unclassifiedValueBase: Decimal;
  /** Cash that matches no bucket. */
  readonly unallocatedCashBase: Decimal;
  /** One per bucket in declaration order, then one per target without a bucket (value 0). */
  readonly allocations: readonly BucketAllocation[];
  readonly holdingsByBucket: ReadonlyMap<string, readonly ValuedHolding[]>;
  /** Holdings that match no bucket (including unpriced ones), in portfolio order. */
  readonly unclassified: readonly ValuedHolding[];
}

export function allocationResult(
  init: Init<AllocationResult, "allocations" | "holdingsByBucket" | "unclassified">,
): AllocationResult {
  return withDefaults<AllocationResult>(
    { allocations: [], holdingsByBucket: new Map(), unclassified: [] },
    init,
  );
}

/** `AllocationResult.unclassified_weight`: float share in unclassified holdings (0 when total is 0). */
export function unclassifiedWeight(result: AllocationResult): number {
  return ratio(result.unclassifiedValueBase, result.totalBase) || 0;
}

/** `AllocationResult.allocation(bucket_id)`. */
export function allocationOf(result: AllocationResult, bucketId: string): BucketAllocation | null {
  return result.allocations.find((a) => a.bucketId === bucketId) ?? null;
}

// --- market view --------------------------------------------------------------------------------

/** Market reference data as of `asOf`: instrument metadata, daily bars and manual valuations. */
export interface MarketView {
  readonly asOf: CalendarDate;
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  /** Daily bars per instrument, oldest first, dated on/before `asOf`. */
  readonly bars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
  /** Manual valuations per instrument, oldest first. */
  readonly manualValuations: ReadonlyMap<InstrumentId, readonly ManualValuation[]>;
}

export function marketView(
  init: Init<MarketView, "instruments" | "bars" | "manualValuations">,
): MarketView {
  return withDefaults<MarketView>(
    { instruments: new Map(), bars: new Map(), manualValuations: new Map() },
    init,
  );
}

/** `MarketView.instrument(id)`. */
export function viewInstrument(view: MarketView, instrumentId: InstrumentId): Instrument | null {
  return view.instruments.get(instrumentId) ?? null;
}

/** `MarketView.series(id)`: all bars, oldest first (empty when none). */
export function viewSeries(view: MarketView, instrumentId: InstrumentId): readonly PriceBar[] {
  return view.bars.get(instrumentId) ?? [];
}

/** `MarketView.last_bar(id)`. */
export function viewLastBar(view: MarketView, instrumentId: InstrumentId): PriceBar | null {
  const series = view.bars.get(instrumentId);
  return series && series.length > 0 ? (series[series.length - 1] as PriceBar) : null;
}

/** `MarketView.last_bars(id, count)`: the newest `count` bars (fewer when shorter), oldest first. */
export function viewLastBars(
  view: MarketView,
  instrumentId: InstrumentId,
  count: number,
): readonly PriceBar[] {
  const series = viewSeries(view, instrumentId);
  return series.length <= count ? series : series.slice(series.length - count);
}

/** `MarketView.manual_valuation(id, on)`: newest valuation dated on/before `on` (default `asOf`). */
export function viewManualValuation(
  view: MarketView,
  instrumentId: InstrumentId,
  on: CalendarDate | null = null,
): ManualValuation | null {
  const limit = on ?? view.asOf;
  let best: ManualValuation | null = null;
  for (const valuation of view.manualValuations.get(instrumentId) ?? []) {
    if (valuation.asOf <= limit && (best === null || valuation.asOf >= best.asOf)) best = valuation;
  }
  return best;
}
