/** Market data: daily price bars and FX rates (`investments/domain/market_data.py`). */

import type { DateTime } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import {
  type CalendarDate,
  Currencies,
  type Currency,
  type Init,
  type InstrumentId,
  withDefaults,
} from "./values.js";

/** One daily bar of an instrument, prices in the instrument's currency. Key: (instrument, date). */
export interface PriceBar {
  readonly instrumentId: InstrumentId;
  /** Exchange calendar date of the session. */
  readonly date: CalendarDate;
  readonly close: Decimal;
  /** Id of the price source that delivered the bar (`stooq`, `yahoo`). */
  readonly source: string;
  readonly fetchedAt: DateTime | null;
  readonly open: Decimal | null;
  readonly high: Decimal | null;
  readonly low: Decimal | null;
  /** Python int; a JS number is exact up to 2^53. */
  readonly volume: number | null;
  /**
   * Quote currency the source reported after minor-unit normalization (always the instrument
   * currency: mismatches are rejected), null when the source reports none (stooq).
   */
  readonly currency: Currency | null;
}

export function priceBar(
  init: Init<PriceBar, "fetchedAt" | "open" | "high" | "low" | "volume" | "currency">,
): PriceBar {
  return withDefaults<PriceBar>(
    { fetchedAt: null, open: null, high: null, low: null, volume: null, currency: null },
    init,
  );
}

/**
 * A daily FX rate: `rate` units of `base` per 1 unit of `quote` (NBP table A: PLN per 1 USD).
 * Key: (base, quote, date).
 */
export interface FxRate {
  readonly quote: Currency;
  /** Effective date of the rate (NBP table date). */
  readonly date: CalendarDate;
  readonly rate: Decimal;
  readonly source: string;
  readonly fetchedAt: DateTime | null;
  readonly base: Currency;
}

export function fxRate(init: Init<FxRate, "fetchedAt" | "base">): FxRate {
  return withDefaults<FxRate>({ fetchedAt: null, base: Currencies.PLN }, init);
}
