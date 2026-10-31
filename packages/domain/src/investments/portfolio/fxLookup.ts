/**
 * In-memory FX lookup (on/before a date, inverse and cross rates) (`fx_lookup.py`). Pure: the
 * persistence layer preloads the needed rates (`fxCurrenciesFor`) and hands the lookup to valuation.
 */

import { type Decimal, ONE, ZERO } from "../../decimal.js";
import { type FxLookup, type FxQuote, fxQuote } from "../domain/fx.js";
import type { FxRate } from "../domain/marketData.js";
import {
  type DatedPrice,
  type MarketView,
  type PortfolioSnapshot,
  viewInstrument,
  viewManualValuation,
} from "../domain/snapshot.js";
import {
  type CalendarDate,
  Currencies,
  type Currency,
  dividedBy,
  exact,
  type InstrumentId,
} from "../domain/values.js";

const pairKey = (base: Currency, quote: Currency): string => `${base}/${quote}`;

/** The earlier of two ISO dates (string order is date order). */
const olderDate = (a: CalendarDate, b: CalendarDate): CalendarDate => (b < a ? b : a);

/** Index of the first date > `on` (Python `bisect_right`) in ascending ISO dates. */
function bisectRight(dates: readonly CalendarDate[], on: CalendarDate): number {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (on < (dates[mid] as CalendarDate)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * An `FxLookup` over rates held in memory. Resolution for (quote, base): identity, a stored
 * (base, quote) series, the inverse of a stored (quote, base) series, then a cross rate through any
 * stored base (the quote's date is the older leg). Inverse and cross rates are rounded with
 * `dividedBy`. Non-positive rates are ignored; for one (base, quote, date) the last rate wins.
 */
export class InMemoryFxLookup implements FxLookup {
  private readonly series = new Map<
    string,
    { readonly base: Currency; readonly rates: FxRate[] }
  >();
  private readonly dates = new Map<string, CalendarDate[]>();

  constructor(rates: Iterable<FxRate>) {
    const byPair = new Map<string, { base: Currency; byDate: Map<CalendarDate, FxRate> }>();
    for (const rate of rates) {
      if (rate.rate.lte(ZERO)) continue;
      const key = pairKey(rate.base, rate.quote);
      let entry = byPair.get(key);
      if (entry === undefined) {
        entry = { base: rate.base, byDate: new Map() };
        byPair.set(key, entry);
      }
      entry.byDate.set(rate.date, rate);
    }
    for (const [key, { base, byDate }] of byPair) {
      const sorted = [...byDate.values()].sort((a, b) =>
        a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
      );
      this.series.set(key, { base, rates: sorted });
      this.dates.set(
        key,
        sorted.map((r) => r.date),
      );
    }
  }

  rateOnOrBefore(
    quote: Currency,
    on: CalendarDate,
    base: Currency = Currencies.PLN,
  ): Decimal | null {
    return this.quoteOnOrBefore(quote, on, base)?.rate ?? null;
  }

  quoteOnOrBefore(
    quote: Currency,
    on: CalendarDate,
    base: Currency = Currencies.PLN,
  ): FxQuote | null {
    return exact(() => this.resolve(quote, on, base))();
  }

  private resolve(quote: Currency, on: CalendarDate, base: Currency): FxQuote | null {
    if (quote === base) return fxQuote(ONE, on);
    const direct = this.find(base, quote, on);
    if (direct !== null) return fxQuote(direct.rate, direct.date);
    const inverse = this.find(quote, base, on);
    if (inverse !== null) return fxQuote(dividedBy(ONE, inverse.rate), inverse.date);
    const pivots = new Set([...this.series.values()].map((s) => s.base));
    for (const pivot of pivots) {
      const quoteInPivot = this.find(pivot, quote, on);
      const baseInPivot = this.find(pivot, base, on);
      if (quoteInPivot !== null && baseInPivot !== null) {
        return fxQuote(
          dividedBy(quoteInPivot.rate, baseInPivot.rate),
          olderDate(quoteInPivot.date, baseInPivot.date),
        );
      }
    }
    return null;
  }

  private find(base: Currency, quote: Currency, on: CalendarDate): FxRate | null {
    const key = pairKey(base, quote);
    const dates = this.dates.get(key);
    if (dates === undefined || dates.length === 0) return null;
    const index = bisectRight(dates, on);
    return index === 0 ? null : ((this.series.get(key)?.rates[index - 1] as FxRate) ?? null);
  }
}

/**
 * `amount` in `source` converted to `target` at the rate on/before `on` (no age limit), or null when
 * no rate is known.
 */
export const convert = exact(
  (
    fx: FxLookup,
    amount: Decimal,
    source: Currency,
    target: Currency,
    on: CalendarDate,
  ): Decimal | null => {
    const rate = fx.rateOnOrBefore(source, on, target);
    return rate === null ? null : amount.mul(rate);
  },
);

/** What `valuePortfolio` can ask the FX lookup for (`fx_currencies_for`). */
export interface FxNeeds {
  /** Every currency of lots, cash, held instruments, manual valuations, last trade prices and
   * realized trades, plus the base currency. */
  readonly currencies: ReadonlySet<Currency>;
  /** The oldest date needed (oldest lot / realized open date, else the snapshot date). */
  readonly oldest: CalendarDate;
}

/**
 * The currencies and the oldest date `valuePortfolio` may need rates for. The loader preloads rates
 * of these currencies from that date (plus the newest rate before it) up to the snapshot date.
 */
export function fxCurrenciesFor(
  snapshot: PortfolioSnapshot,
  market: MarketView,
  baseCurrency: Currency,
  lastKnownPrices: ReadonlyMap<InstrumentId, DatedPrice> | null = null,
): FxNeeds {
  const fallback = lastKnownPrices ?? snapshot.lastTradePrices;
  let oldest = snapshot.asOf;
  const currencies = new Set<Currency>([baseCurrency]);
  for (const h of snapshot.holdings) {
    currencies.add(h.currency);
    const instrument = viewInstrument(market, h.instrumentId);
    if (instrument !== null) currencies.add(instrument.currency);
    const price = fallback.get(h.instrumentId);
    if (price !== undefined) currencies.add(price.currency);
    const valuation = viewManualValuation(market, h.instrumentId, snapshot.asOf);
    if (valuation !== null) currencies.add(valuation.currency);
    for (const lot of h.lots) {
      currencies.add(lot.currency);
      if (lot.openDate < oldest) oldest = lot.openDate;
    }
  }
  for (const cash of snapshot.cash) currencies.add(cash.currency);
  for (const trade of snapshot.realized) {
    currencies.add(trade.currency);
    currencies.add(trade.costCurrency);
    if (trade.openDate < oldest) oldest = trade.openDate;
  }
  return Object.freeze({ currencies, oldest });
}
