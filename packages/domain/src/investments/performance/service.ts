/**
 * The pure part of `performance/service.py`: what one profile's performance is computed from
 * (`PerformanceInputs`, the service's `Loaded`), the full-history computation (`computePerformance`,
 * `_compute`) and the small helpers the views share (`sample`, `checkRange`, `isIsin`). Loading the
 * inputs is the store's (`@cashu/store` investments performance), the JSON shaping is `views.ts`.
 */

import { addDays, daysBetween } from "../../dates.js";
import { pyStrip, pyUpper } from "../../text.js";
import type { AllocationPlan } from "../domain/buckets.js";
import type { FxLookup } from "../domain/fx.js";
import type { Instrument, InstrumentRename, ManualValuation } from "../domain/instrument.js";
import type { PriceBar } from "../domain/marketData.js";
import type { Transaction } from "../domain/transaction.js";
import type { AccountId, CalendarDate, Currency, InstrumentId } from "../domain/values.js";
import { benchmarkPrices } from "./benchmark.js";
import { isRangeKey, monthEndPositions, RANGES, type RangeKey, rangeBase } from "./report.js";
import { buildSeries, emptySeries, type PortfolioSeries, type ValuationPolicy } from "./series.js";

/** Bars and rates are loaded from this many days before the first transaction (weekends, holidays). */
export const HISTORY_MARGIN_DAYS = 14;

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** `service.is_isin`. */
export function isIsin(value: string): boolean {
  return ISIN.test(pyUpper(pyStrip(value)));
}

/** `service.RangeError`: an unknown range key (the message is safe to show). */
export class PerformanceRangeError extends Error {
  constructor() {
    super(`range must be one of ${RANGES.join(", ")}`);
    this.name = "PerformanceRangeError";
  }
}

/** `service.check_range`. */
export function checkRange(rangeKey: string): RangeKey {
  if (!isRangeKey(rangeKey)) throw new PerformanceRangeError();
  return rangeKey;
}

/** `service/strategy.State`. */
export type StrategyState = "missing" | "valid" | "partial" | "invalid";

/** The strategy's benchmark section (`strategy.Benchmark`: its `id` and market `proxy`). */
export interface PerformanceBenchmark {
  readonly id: string;
  readonly proxy: string;
  /** The comparison currency; absent = the base currency (the backfill's first probe guess). */
  readonly currency?: Currency;
}

/**
 * What performance reads from the profile's strategy (`strategy_files.load(...)`): its state, the
 * benchmark section, the data-quality thresholds (the defaults without a strategy), and the base
 * currency and allocation plan of a usable strategy (null otherwise).
 */
export interface PerformanceStrategy {
  readonly state: StrategyState;
  readonly benchmark: PerformanceBenchmark | null;
  readonly policy: ValuationPolicy;
  /** null without a usable strategy: the profile's base currency is used. */
  readonly strategy: {
    readonly baseCurrency: Currency;
    readonly allocation: AllocationPlan;
  } | null;
}

/** A brokerage account as the views label it. */
export interface PerformanceAccount {
  readonly id: AccountId;
  readonly name: string;
  readonly currency: string;
}

/** `service.Loaded`: one profile's inputs, read at one point. */
export interface PerformanceInputs {
  readonly base: Currency;
  readonly policy: ValuationPolicy;
  readonly plan: AllocationPlan | null;
  readonly benchmark: PerformanceBenchmark | null;
  readonly strategyState: StrategyState;
  /** The profile's brokerage accounts, oldest first. */
  readonly accounts: readonly PerformanceAccount[];
  /** Transactions up to the end date, chronological. */
  readonly txns: readonly Transaction[];
  readonly renames: readonly InstrumentRename[];
  /** The profile's own view of every referenced instrument and the benchmark proxy. */
  readonly instruments: ReadonlyMap<InstrumentId, Instrument>;
  /** Stored closes of the referenced instruments (the proxy only when referenced too). */
  readonly bars: ReadonlyMap<InstrumentId, readonly PriceBar[]>;
  /** Manual valuations per instrument, by date. */
  readonly manual: ReadonlyMap<InstrumentId, readonly ManualValuation[]>;
  readonly fx: FxLookup;
  readonly benchmarkInstrument: Instrument | null;
  readonly benchmarkBars: readonly PriceBar[];
}

/** `service.Computed`: the full-history computation of one profile up to `end`. */
export interface ComputedPerformance {
  readonly inputs: PerformanceInputs;
  readonly end: CalendarDate;
  readonly series: PortfolioSeries;
  /** The benchmark proxy's close in the base currency per series day; null when none is usable. */
  readonly benchPrices: readonly (number | null)[] | null; // float-ok: Python float prices
}

export const hasHistory = (c: ComputedPerformance): boolean => c.inputs.txns.length > 0;

/** `portfolio.base_currency(profile, strategy)`: the usable strategy's, else the profile's. */
export function baseCurrencyOf(
  profileBase: Currency | null,
  strategy: PerformanceStrategy,
): Currency {
  if (strategy.strategy !== null) return strategy.strategy.baseCurrency;
  if (profileBase === null) throw new RangeError("profile without a base currency");
  return profileBase;
}

/** `service._compute(loaded, end)`. */
export function computePerformance(
  inputs: PerformanceInputs,
  end: CalendarDate,
): ComputedPerformance {
  const first = inputs.txns[0];
  if (first === undefined) {
    return { inputs, end, series: emptySeries(inputs.base, end), benchPrices: null };
  }
  let firstDate = first.tradeDate;
  for (const t of inputs.txns) if (t.tradeDate < firstDate) firstDate = t.tradeDate;
  const anchor = addDays(firstDate, -1);
  const captures = new Set<CalendarDate>(RANGES.map((k) => rangeBase(k, end, anchor)));
  captures.add(end);
  const series = buildSeries(inputs.txns, {
    instruments: inputs.instruments,
    bars: inputs.bars,
    fx: inputs.fx,
    base: inputs.base,
    end,
    renames: inputs.renames,
    manualValuations: inputs.manual,
    policy: inputs.policy,
    captureDates: captures,
  });
  let bench: (number | null)[] | null = null; // float-ok: Python float prices
  const proxy = inputs.benchmarkInstrument;
  if (proxy !== null && inputs.benchmarkBars.length > 0) {
    bench = benchmarkPrices(
      series.dates,
      inputs.benchmarkBars,
      proxy.currency,
      inputs.fx,
      inputs.base,
      inputs.policy,
    );
    if (bench.every((p) => p === null)) bench = null;
  }
  return { inputs, end, series, benchPrices: bench };
}

/** Chart sampling step of `sample`. */
export type SampleStep = "day" | "week" | "month";

/**
 * `service.sample`: chart points, daily up to ~13 months, weekly (counted back from the last day) up
 * to ~5 years, month ends beyond. The first and last day are always included.
 */
export function sample(dates: readonly CalendarDate[]): [SampleStep, number[]] {
  const n = dates.length;
  const span = daysBetween(dates[0] as CalendarDate, dates[n - 1] as CalendarDate);
  if (span <= 400) return ["day", Array.from({ length: n }, (_, i) => i)];
  let picked: Set<number>;
  let step: SampleStep;
  if (span <= 1900) {
    picked = new Set(Array.from({ length: n }, (_, i) => i).filter((i) => (n - 1 - i) % 7 === 0));
    step = "week";
  } else {
    picked = new Set(monthEndPositions(dates));
    step = "month";
  }
  picked.add(0);
  picked.add(n - 1);
  return [step, [...picked].sort((a, b) => a - b)];
}
