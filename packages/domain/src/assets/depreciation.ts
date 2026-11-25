/**
 * Declining-balance depreciation for vehicle (and similar) asset accounts
 * (`modules/assets/depreciation.py`).
 *
 * Kept apart from the loan amortization model: a car is an asset that loses value over time, never
 * a liability. The value is computed on read (like a loan's outstanding balance), so the net-worth
 * history shows it declining smoothly.
 *
 * The curve is float math in Python (`price * (1 - rate) ** years`, then `round(v, 2)` and
 * `Decimal(str(...))`); this port repeats the same float operations and the same conversion, so the
 * stored Decimal is identical. `**` is CPython's platform `pow` against V8's: the differential vectors
 * (`depreciation.vectors.test.ts`) pin that they agree.
 */

import { ZERO_00 } from "../core/index.js";
import { daysBetween, type IsoDate } from "../dates.js";
import { D, type Decimal, floatRepr, roundFloat } from "../decimal.js";

/** `DAYS_PER_YEAR`. */
export const DAYS_PER_YEAR = 365.25;

/**
 * Python would build a complex number (a negative base to a fractional power: a rate above 100 %)
 * and fail on the comparison or the rounding after it.
 */
export class DepreciationRateError extends Error {
  constructor() {
    super("depreciation rate above 100 % has no real value at a fractional age");
    this.name = "DepreciationRateError";
  }
}

/**
 * `value`: the estimated market value at `asOf`. 0 before the purchase date (not owned yet), the
 * full price on the day, then declining-balance decay toward `floor` (or about 0 without a floor).
 * `annualRatePct` in percent (15 = 15 %/yr).
 */
export function depreciatedValue(
  purchasePrice: Decimal,
  purchaseDate: IsoDate,
  annualRatePct: Decimal,
  asOf: IsoDate,
  floor: Decimal | null = null,
): Decimal {
  if (asOf < purchaseDate) return ZERO_00;
  const years = daysBetween(purchaseDate, asOf) / DAYS_PER_YEAR;
  const rate = annualRatePct.toFloat() / 100.0;
  let v = purchasePrice.toFloat() * (1.0 - rate) ** years;
  if (Number.isNaN(v)) throw new DepreciationRateError();
  if (floor !== null) {
    // Python max(v, f): v unless f is strictly greater.
    const f = floor.toFloat();
    if (f > v) v = f;
  }
  return D(floatRepr(roundFloat(v, 2)));
}

/** The stored curve of a depreciating account (`models.Depreciation`), in the caller's id space. */
export interface DepreciationTerms {
  /** The account the curve values. */
  readonly accountId: string;
  readonly purchasePrice: Decimal;
  readonly purchaseDate: IsoDate;
  /** Percent, e.g. 15. */
  readonly annualRate: Decimal;
  /** null = no floor. */
  readonly floor: Decimal | null;
}

/** `value_of`: `depreciatedValue` over a stored curve. */
export function curveValue(dep: DepreciationTerms, asOf: IsoDate): Decimal {
  return depreciatedValue(dep.purchasePrice, dep.purchaseDate, dep.annualRate, asOf, dep.floor);
}
