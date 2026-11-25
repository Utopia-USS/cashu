/**
 * Values a snapshot in the base currency: prices from the market view, FX from an `FxLookup`
 * (`valuation.py`). Pure.
 */

import { type Decimal, ZERO } from "../../decimal.js";
import { InstrumentStatus, ValuationMode } from "../domain/enums.js";
import { DEFAULT_MAX_FX_AGE_DAYS, type FxLookup, fxQuoteAgeDays } from "../domain/fx.js";
import { type Instrument, placeholderInstrument } from "../domain/instrument.js";
import type { PriceBar } from "../domain/marketData.js";
import {
  countedBase,
  type DatedPrice,
  type Holding,
  holdingAverageCost,
  lotCostBasis,
  type MarketView,
  type PortfolioSnapshot,
  realizedCost,
  realizedProceeds,
  type ValuedCash,
  type ValuedPortfolio,
  valuedCash,
  valuedHolding,
  valuedPortfolio,
  valuedRealizedTrade,
  viewInstrument,
  viewManualValuation,
  viewSeries,
} from "../domain/snapshot.js";
import {
  type AccountId,
  type CalendarDate,
  type Currency,
  daysBetween,
  dividedBy,
  exact,
  type InstrumentId,
  ratio,
} from "../domain/values.js";
import {
  frozenValuedAtZero,
  lastKnownPriceUsed,
  missingCostBasis,
  missingFxRate,
  missingInstrument,
  missingManualValuation,
  missingPrice,
  type PortfolioWarning,
  staleFxRate,
  stalePrice,
  warningKey,
} from "../domain/warnings.js";
import { restrictSnapshot } from "./snapshotBuilder.js";

/** The mode valuation uses: a frozen instrument is valued manually whatever its configured mode. */
export function effectiveValuationMode(instrument: Instrument): ValuationMode {
  if (instrument.status === InstrumentStatus.FROZEN) return ValuationMode.MANUAL;
  return instrument.valuationMode ?? ValuationMode.MARKET;
}

export interface ValuePortfolioOptions {
  /** Restrict to these accounts (the returned `snapshot` is then the restricted one). */
  readonly accountIds?: ReadonlySet<AccountId> | null;
  /** Fallback prices (default `snapshot.lastTradePrices`). */
  readonly lastKnownPrices?: ReadonlyMap<InstrumentId, DatedPrice> | null;
  readonly maxFxAgeDays?: number;
}

/** A price with its date; `currency` null for market bars (instrument currency), `date` null at cost. */
interface Price {
  readonly price: Decimal;
  readonly date: CalendarDate | null;
  readonly currency: Currency | null;
  readonly isStale: boolean;
}

interface Draft {
  readonly holding: Holding;
  readonly instrument: Instrument;
  readonly mode: ValuationMode;
  readonly price: Price | null;
  readonly marketValueBase: Decimal | null;
  readonly costBasisBase: Decimal | null;
  readonly missingFxCurrency: Currency | null;
}

type Convert = (amount: Decimal, currency: Currency, on: CalendarDate) => Decimal | null;

const priceCurrencyOf = (d: Draft): Currency | null =>
  d.price === null ? null : (d.price.currency ?? d.instrument.currency);

/** Stale price, last known price, or no price at all. */
const isStale = (d: Draft): boolean => (d.price === null ? true : d.price.isStale);

/**
 * Values `snapshot` in `baseCurrency` (port of the Kompas `valuePortfolio` with R2/R4/R12/R14/R15,
 * manual valuation and frozen instruments); the rules are documented on Python's
 * `value_portfolio`: market bars (stale after `maxPriceAgeDays`) falling back to the last trade price,
 * cost mode at the cost basis, manual mode from the newest manual valuation (frozen = 0), FX older
 * than `maxFxAgeDays` unused, negative cash counted as 0, realized trades at trade-date FX.
 */
export const valuePortfolio = exact(
  (
    snapshot: PortfolioSnapshot,
    market: MarketView,
    fx: FxLookup,
    baseCurrency: Currency,
    maxPriceAgeDays: number, // float-ok: a whole day count (Python int), not money
    options: ValuePortfolioOptions = {},
  ): ValuedPortfolio => {
    const accountIds = options.accountIds ?? null;
    const maxFxAgeDays = options.maxFxAgeDays ?? DEFAULT_MAX_FX_AGE_DAYS;
    const scoped = accountIds === null ? snapshot : restrictSnapshot(snapshot, accountIds);
    const fallbackPrices = options.lastKnownPrices ?? scoped.lastTradePrices;
    const asOf = scoped.asOf;
    // Python dict keyed by the warning value: duplicates collapse, first occurrence order kept.
    const warnings = new Map<string, PortfolioWarning>();
    const missingFx = new Set<Currency>();
    const marketPrices = new Map<InstrumentId, Price | null>();

    const warn = (warning: PortfolioWarning): void => {
      const key = warningKey(warning);
      if (!warnings.has(key)) warnings.set(key, warning);
    };

    const marketPrice = (instrumentId: InstrumentId): Price | null => {
      if (marketPrices.has(instrumentId)) return marketPrices.get(instrumentId) ?? null;
      let price: Price | null;
      const bar = lastBarOnOrBefore(viewSeries(market, instrumentId), asOf);
      const fallback = fallbackPrices.get(instrumentId);
      if (bar !== null) {
        const age = daysBetween(bar.date, asOf);
        const stale = age > maxPriceAgeDays;
        if (stale) warn(stalePrice({ instrumentId, priceDate: bar.date, ageDays: age }));
        price = { price: bar.close, date: bar.date, currency: null, isStale: stale };
      } else if (fallback !== undefined && fallback.date <= asOf) {
        warn(lastKnownPriceUsed({ instrumentId, priceDate: fallback.date, price: fallback.price }));
        price = {
          price: fallback.price,
          date: fallback.date,
          currency: fallback.currency,
          isStale: true,
        };
      } else {
        warn(missingPrice({ instrumentId, asOf }));
        price = null;
      }
      marketPrices.set(instrumentId, price);
      return price;
    };

    /** `amount` at the usable rate for `on`, or null (a warning when `report`). */
    const convertAt = (
      amount: Decimal,
      currency: Currency,
      on: CalendarDate,
      report = true,
    ): Decimal | null => {
      const quote = fx.quoteOnOrBefore(currency, on, baseCurrency);
      if (quote === null) {
        if (report) warn(missingFxRate({ currency, base: baseCurrency, date: on }));
        return null;
      }
      const age = fxQuoteAgeDays(quote, on);
      if (age > maxFxAgeDays) {
        if (report) {
          warn(
            staleFxRate({
              currency,
              base: baseCurrency,
              date: on,
              rateDate: quote.date,
              ageDays: age,
            }),
          );
        }
        return null;
      }
      return amount.mul(quote.rate);
    };
    const convert: Convert = (amount, currency, on) => convertAt(amount, currency, on);

    const drafts: Draft[] = [];
    for (const h of scoped.holdings) {
      let instrument = viewInstrument(market, h.instrumentId);
      if (instrument === null) {
        warn(missingInstrument({ instrumentId: h.instrumentId }));
        instrument = placeholderInstrument(h.instrumentId, h.currency);
      }
      const mode = effectiveValuationMode(instrument);

      if (mode === ValuationMode.COST) {
        const costBasisBase = costBasisBaseOf(h, convert);
        let price: Price | null;
        const averageCost = holdingAverageCost(h);
        if (costBasisBase === null) {
          warn(missingCostBasis({ accountId: h.accountId, instrumentId: h.instrumentId }));
          price = null;
        } else if (averageCost !== null) {
          price = { price: averageCost, date: null, currency: h.currency, isStale: false };
        } else {
          // Lots in several currencies: the average cost exists only in the base currency.
          price = {
            price: dividedBy(costBasisBase, h.quantity),
            date: null,
            currency: baseCurrency,
            isStale: false,
          };
        }
        drafts.push({
          holding: h,
          instrument,
          mode,
          price,
          marketValueBase: costBasisBase,
          costBasisBase,
          missingFxCurrency: null,
        });
        continue;
      }

      let price: Price | null;
      if (mode === ValuationMode.MANUAL) {
        const valuation = viewManualValuation(market, h.instrumentId, asOf);
        if (valuation !== null) {
          price = {
            price: valuation.unitValue,
            date: valuation.asOf,
            currency: valuation.currency,
            isStale: false,
          };
        } else if (instrument.status === InstrumentStatus.FROZEN) {
          warn(frozenValuedAtZero({ instrumentId: h.instrumentId }));
          price = { price: ZERO, date: null, currency: instrument.currency, isStale: false };
        } else {
          warn(missingManualValuation({ instrumentId: h.instrumentId, asOf }));
          price = null;
        }
      } else {
        price = marketPrice(h.instrumentId);
      }

      const priceCurrency = price === null ? null : (price.currency ?? instrument.currency);
      let marketValue: Decimal | null = null;
      let missingCurrency: Currency | null = null;
      if (price !== null && priceCurrency !== null) {
        const amount = h.quantity.mul(price.price);
        marketValue =
          mode === ValuationMode.MANUAL && amount.isZero()
            ? ZERO
            : convert(amount, priceCurrency, asOf);
        if (marketValue === null) {
          missingCurrency = priceCurrency;
          missingFx.add(priceCurrency);
        }
      }
      const costBasisBase = costBasisBaseOf(h, convert);
      drafts.push({
        holding: h,
        instrument,
        mode,
        price,
        marketValueBase: marketValue,
        costBasisBase,
        missingFxCurrency: missingCurrency,
      });
    }

    const cash: ValuedCash[] = [];
    for (const balance of scoped.cash) {
      const amountBase = convert(balance.amount, balance.currency, asOf);
      if (amountBase === null) missingFx.add(balance.currency);
      cash.push(valuedCash({ cash: balance, amountBase }));
    }
    const cashBase = cash.reduce((total, c) => total.add(countedBase(c)), ZERO);

    let holdingsBase = ZERO;
    let staleBase = ZERO;
    for (const d of drafts) {
      if (d.marketValueBase === null) continue;
      holdingsBase = holdingsBase.add(d.marketValueBase);
      if (isStale(d)) staleBase = staleBase.add(d.marketValueBase);
    }
    const totalBase = holdingsBase.add(cashBase);

    const valued = drafts.map((d) =>
      valuedHolding({
        holding: d.holding,
        instrument: d.instrument,
        isStale: isStale(d),
        price: d.price === null ? null : d.price.price,
        priceDate: d.price === null ? null : d.price.date,
        marketValueBase: d.marketValueBase,
        costBasisBase: d.costBasisBase,
        unrealizedPct: unrealizedPct(d.marketValueBase, d.costBasisBase),
        weight: ratio(d.marketValueBase, totalBase),
        valuationMode: d.mode,
        priceCurrency: priceCurrencyOf(d),
        missingFxCurrency: d.missingFxCurrency,
      }),
    );
    const realized = scoped.realized.map((trade) => {
      const cost = realizedCost(trade);
      return valuedRealizedTrade({
        trade,
        proceedsBase: convertAt(realizedProceeds(trade), trade.currency, trade.closeDate, false),
        costBase:
          cost === null
            ? null
            : convertAt(cost, trade.costCurrency ?? trade.currency, trade.openDate, false),
      });
    });
    return valuedPortfolio({
      snapshot: scoped,
      baseCurrency,
      cashBase,
      totalBase,
      staleWeight: ratio(staleBase, totalBase) || 0,
      valued: Object.freeze(valued),
      cash: Object.freeze(cash),
      warnings: Object.freeze([...warnings.values()]),
      missingFxCurrencies: missingFx,
      realized: Object.freeze(realized),
    });
  },
);

function costBasisBaseOf(h: Holding, convert: Convert): Decimal | null {
  let total = ZERO;
  for (const lot of h.lots) {
    const cost = lotCostBasis(lot);
    if (cost === null) return null;
    const converted = convert(cost, lot.currency, lot.openDate);
    if (converted === null) return null;
    total = total.add(converted);
  }
  return total;
}

function unrealizedPct(marketValue: Decimal | null, costBasis: Decimal | null): number | null {
  if (marketValue === null || costBasis === null || costBasis.isZero()) return null;
  return ratio(marketValue.sub(costBasis), costBasis);
}

function lastBarOnOrBefore(series: readonly PriceBar[], asOf: CalendarDate): PriceBar | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const bar = series[i] as PriceBar;
    if (bar.date <= asOf) return bar;
  }
  return null;
}
