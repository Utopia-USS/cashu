/**
 * Stored (split-adjusted) closes brought to the units the lots hold on a given day
 * (`performance/series.py:PriceAdjuster`). Pure.
 *
 * - Known splits: the portfolio's `split` transactions per instrument (renames resolved; a split of
 *   the same ratio within `SPLIT_DEDUP_WINDOW_DAYS` of an applied one is the same action). A close
 *   used for day `d` is multiplied by every ratio dated after `d`.
 * - Residual scale: each buy / sell with a price in the instrument currency is compared with the
 *   close of its day (the newest bar at most `SCALE_BAR_WINDOW_DAYS` before it, already adjusted for
 *   known splits). Off by more than `SCALE_TOLERANCE` and within 15 % of n or 1/n, that multiple is
 *   the scale of every day up to the trade (the next trade on/after a day decides); days after the
 *   last trade use 1. Other off-scale trades are reported as mismatches.
 */

import { daysBetween } from "../../dates.js";
import { Decimal, roundFloat, roundFloatToInt, ZERO } from "../../decimal.js";
import { TxnType, ValuationMode } from "../domain/enums.js";
import type { Instrument } from "../domain/instrument.js";
import { type PriceBar, priceBar } from "../domain/marketData.js";
import { compareChronological, type Transaction } from "../domain/transaction.js";
import { type CalendarDate, exactDecimals, type InstrumentId } from "../domain/values.js";
import { Fraction } from "../portfolio/fraction.js";
import { SPLIT_DEDUP_WINDOW_DAYS } from "../portfolio/lastTradePrices.js";
import { splitFraction } from "../portfolio/splitRatio.js";
import { effectiveValuationMode } from "../portfolio/valuation.js";
import { fractionToFloat } from "./floats.js";
import type { Renames } from "./renames.js";
import { bisectLeft, bisectRight } from "./search.js";

/** A trade price within this factor of the day's close needs no inferred scale. */
export const SCALE_TOLERANCE = 1.6;
/** An off-scale trade price snaps to n or 1/n when within 15 % of it (log distance). */
export const SCALE_SNAP = Math.log(1.15);
/** A trade is compared with the newest bar at most this many days before it. */
export const SCALE_BAR_WINDOW_DAYS = 3;

const ONE_FRACTION = Fraction.of(1n);

/** A price scale inferred from a trade: closes on/before `until` are multiplied by `factor`. */
export interface PriceScale {
  readonly instrumentId: InstrumentId;
  readonly until: CalendarDate;
  readonly factor: Fraction;
}

/** A trade price that is neither near the day's close nor a clean multiple of it. */
export interface PriceMismatch {
  readonly instrumentId: InstrumentId;
  readonly date: CalendarDate;
  /** Rounded to 4 places (Python `round(ratio, 4)`). */
  readonly ratio: number;
}

/** 1 for a ratio near 1, n or 1/n for a clean split multiple, null otherwise (`_snap_scale`). */
export function snapScale(ratio: number): Fraction | null {
  if (ratio <= 0) return null;
  if (1 / SCALE_TOLERANCE <= ratio && ratio <= SCALE_TOLERANCE) return ONE_FRACTION;
  const n = ratio > 1 ? roundFloatToInt(ratio) : roundFloatToInt(1 / ratio);
  if (n < 2n || n > 1000n) return null;
  const candidate = ratio > 1 ? Fraction.of(n) : Fraction.of(1n, n);
  if (Math.abs(Math.log(ratio / fractionToFloat(candidate))) <= SCALE_SNAP) return candidate;
  return null;
}

export class PriceAdjuster {
  private readonly bars = new Map<InstrumentId, readonly PriceBar[]>();
  private readonly dates = new Map<InstrumentId, readonly CalendarDate[]>();
  private readonly cache = new Map<string, PriceBar>();
  private readonly splits = new Map<InstrumentId, [CalendarDate, Fraction][]>();
  private readonly observations = new Map<InstrumentId, [CalendarDate, Fraction][]>();
  private readonly obsDates = new Map<InstrumentId, CalendarDate[]>();
  readonly scales: readonly PriceScale[];
  readonly mismatches: readonly PriceMismatch[];

  constructor(
    txns: readonly Transaction[],
    renames: Renames,
    bars: ReadonlyMap<InstrumentId, readonly PriceBar[]>,
    instruments: ReadonlyMap<InstrumentId, Instrument>,
  ) {
    for (const [id, series] of bars) {
      if (series.length === 0) continue;
      this.bars.set(id, [...series]);
      this.dates.set(
        id,
        series.map((b) => b.date),
      );
    }
    const ordered = [...txns].sort(compareChronological);
    for (const t of ordered) {
      if (t.type !== TxnType.SPLIT || t.splitRatio === null || t.splitRatio.lte(ZERO)) continue;
      const iid = renames.resolve(t.instrumentId, t.tradeDate);
      if (iid === null) continue;
      const ratio = splitFraction(t.splitRatio);
      let applied = this.splits.get(iid);
      if (applied === undefined) {
        applied = [];
        this.splits.set(iid, applied);
      }
      if (
        applied.some(
          ([d, r]) =>
            r.eq(ratio) && Math.abs(daysBetween(t.tradeDate, d)) <= SPLIT_DEDUP_WINDOW_DAYS,
        )
      ) {
        continue;
      }
      applied.push([t.tradeDate, ratio]);
    }

    const scales: PriceScale[] = [];
    const mismatches: PriceMismatch[] = [];
    for (const t of ordered) {
      if (t.type !== TxnType.BUY && t.type !== TxnType.SELL) continue;
      if (t.price === null || t.price.isZero() || t.price.lte(ZERO)) continue;
      const iid = renames.resolve(t.instrumentId, t.tradeDate);
      const instrument = iid === null ? undefined : instruments.get(iid);
      if (iid === null || instrument === undefined || t.currency !== instrument.currency) continue;
      if (effectiveValuationMode(instrument) !== ValuationMode.MARKET) continue;
      const bar = this.rawBar(iid, t.tradeDate);
      if (bar === null || daysBetween(bar.date, t.tradeDate) > SCALE_BAR_WINDOW_DAYS) continue;
      const close = Fraction.fromDecimal(bar.close).mul(this.knownFactor(iid, t.tradeDate));
      if (!close.gt(Fraction.of(0n))) continue;
      const ratio = fractionToFloat(Fraction.fromDecimal(t.price).div(close));
      const scale = snapScale(ratio);
      if (scale === null) {
        mismatches.push(
          Object.freeze({ instrumentId: iid, date: t.tradeDate, ratio: roundFloat(ratio, 4) }),
        );
        continue;
      }
      let obs = this.observations.get(iid);
      if (obs === undefined) {
        obs = [];
        this.observations.set(iid, obs);
      }
      obs.push([t.tradeDate, scale]);
    }
    for (const [iid, obs] of this.observations) {
      // Python `obs.sort(key=date)`: stable, in place
      obs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [day, scale] of obs) {
        if (!scale.eq(ONE_FRACTION)) {
          scales.push(Object.freeze({ instrumentId: iid, until: day, factor: scale }));
        }
      }
      this.obsDates.set(
        iid,
        obs.map(([d]) => d),
      );
    }
    this.scales = Object.freeze(scales);
    this.mismatches = Object.freeze(mismatches);
  }

  private rawBar(instrumentId: InstrumentId, day: CalendarDate): PriceBar | null {
    const dates = this.dates.get(instrumentId);
    if (dates === undefined) return null;
    const i = bisectRight(dates, day) - 1;
    return i < 0 ? null : ((this.bars.get(instrumentId) as readonly PriceBar[])[i] as PriceBar);
  }

  /** Product of the known split ratios dated after `day`. */
  knownFactor(instrumentId: InstrumentId, day: CalendarDate): Fraction {
    let factor = ONE_FRACTION;
    for (const [splitDay, ratio] of this.splits.get(instrumentId) ?? []) {
      if (splitDay > day) factor = factor.mul(ratio);
    }
    return factor;
  }

  /** The inferred scale of `day` (the next observation on/after it decides; 1 after the last). */
  residual(instrumentId: InstrumentId, day: CalendarDate): Fraction {
    const dates = this.obsDates.get(instrumentId);
    if (dates === undefined || dates.length === 0) return ONE_FRACTION;
    const i = bisectLeft(dates, day);
    if (i >= dates.length) return ONE_FRACTION;
    return (
      (this.observations.get(instrumentId) as [CalendarDate, Fraction][])[i] as [
        CalendarDate,
        Fraction,
      ]
    )[1];
  }

  /** The newest stored bar on/before `day` with its close in the units held on `day`. */
  barOn(instrumentId: InstrumentId, day: CalendarDate): PriceBar | null {
    const dates = this.dates.get(instrumentId);
    if (dates === undefined) return null;
    const i = bisectRight(dates, day) - 1;
    if (i < 0) return null;
    const factor = this.knownFactor(instrumentId, day).mul(this.residual(instrumentId, day));
    const bar = (this.bars.get(instrumentId) as readonly PriceBar[])[i] as PriceBar;
    if (factor.eq(ONE_FRACTION)) return bar;
    const key = `${instrumentId}\u0000${i}\u0000${factor.numerator}/${factor.denominator}`;
    let cached = this.cache.get(key);
    if (cached === undefined) {
      const close = exactDecimals(() =>
        bar.close.mul(Decimal.fromInt(factor.numerator)).div(Decimal.fromInt(factor.denominator)),
      );
      cached = priceBar({
        instrumentId: bar.instrumentId,
        date: bar.date,
        close,
        source: bar.source,
        currency: bar.currency,
      });
      this.cache.set(key, cached);
    }
    return cached;
  }

  lastBarDate(instrumentId: InstrumentId): CalendarDate | null {
    const dates = this.dates.get(instrumentId);
    return dates === undefined ? null : (dates[dates.length - 1] as CalendarDate);
  }
}
