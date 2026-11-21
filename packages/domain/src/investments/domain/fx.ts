/** FX lookup contract used by valuation and rules (`investments/domain/fx.py`). */

import type { Decimal } from "../../decimal.js";
import { type CalendarDate, type Currency, daysBetween } from "./values.js";

/**
 * Default of the strategy's `data.max_fx_age_days`: an FX rate older than this many calendar days
 * relative to the date it is needed for counts as missing (NBP publishes every business day).
 */
export const DEFAULT_MAX_FX_AGE_DAYS = 10;

/**
 * An FX rate with the date it was published for. For an inverse rate the date is the stored rate's,
 * for a cross rate the older of the two legs, for the identity rate the requested date.
 */
export interface FxQuote {
  /** Units of the base currency per 1 unit of the quote currency. */
  readonly rate: Decimal;
  readonly date: CalendarDate;
}

export function fxQuote(rate: Decimal, date: CalendarDate): FxQuote {
  return Object.freeze({ rate, date });
}

/** `FxQuote.age_days`: calendar days between the quote's date and `neededFor` (0 on that very day). */
export function fxQuoteAgeDays(quote: FxQuote, neededFor: CalendarDate): number {
  return daysBetween(quote.date, neededFor);
}

/**
 * Daily FX rates as of a date (synchronous, so valuation stays a pure function). `base` defaults to
 * PLN in implementations, as in Python.
 */
export interface FxLookup {
  /**
   * Units of `base` per 1 `quote` from the newest rate dated on/before `on` (exactly 1 when
   * `quote === base`), with the date of the rate used; null when unknown.
   */
  quoteOnOrBefore(quote: Currency, on: CalendarDate, base?: Currency): FxQuote | null;
  /** The rate of `quoteOnOrBefore`, or null. */
  rateOnOrBefore(quote: Currency, on: CalendarDate, base?: Currency): Decimal | null;
}
