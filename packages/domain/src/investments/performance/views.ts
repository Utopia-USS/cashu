/**
 * The JSON views of `performance/service.py` over a computed performance: `performance_view`
 * (`GET /investments/performance`), `attribution_view` (`GET /investments/performance/attribution`)
 * and `mcp_summary` (the MCP `history_metrics` tool). Every number comes from the performance core;
 * this file only selects, rounds (`_money` = 2 places, `_ratio` = 6 places, as Python floats) and
 * labels. Keys keep the Python names: they are the API contract the dashboard reads. Ids are the
 * domain ids the inputs carry (store gids in the app).
 */

import { D, type Decimal, floatRepr, roundFloat } from "../../decimal.js";
import { instrumentLabel } from "../domain/instrument.js";
import type { AccountId, CalendarDate, InstrumentId } from "../domain/values.js";
import type { Fraction } from "../portfolio/fraction.js";
import {
  accountLevelTotal,
  attribute,
  bucketOf,
  type Concentration,
  concentration,
  groupByBucket,
  instrumentsPnl,
  pnlOf,
} from "./attribution.js";
import { pySum } from "./floats.js";
import { Renames } from "./renames.js";
import {
  computeRange,
  perYear,
  type RangeBenchmark,
  type RangeKey,
  type RangeMetrics,
  type RangeSummary,
  ROLLING_MONTHS,
  type RollingSummary,
  rangeEnd,
  rangeStart,
  rolling,
  rollingSummary,
  type YearReturn,
} from "./report.js";
import { type Drawdown, drawdownToDict, twrIndex } from "./returns.js";
import { combineSeries, seriesIndexOf } from "./series.js";
import { type ComputedPerformance, hasHistory, type SampleStep, sample } from "./service.js";

// Every `number` below is a Python float or int of the JSON view (rounded floats for money, as the
// service writes them); the computation itself keeps Decimal where Python does.

/** `_money`: `round(float(value), 2)`. */
function money(value: number | Decimal | null): number | null {
  if (value === null) return null;
  return roundFloat(typeof value === "number" ? value : value.toFloat(), 2);
}

/** `_ratio`: `round(float(value), 6)`. */
function ratio(value: number | null): number | null {
  return value === null ? null : roundFloat(value, 6);
}

/** `Drawdown.to_dict()`. */
export interface DrawdownView {
  readonly depth: number;
  readonly peak: CalendarDate | null;
  readonly trough: CalendarDate | null;
  readonly recovered: CalendarDate | null;
}

function drawdownOut(dd: Drawdown | null): DrawdownView | null {
  return dd === null ? null : drawdownToDict(dd);
}

export type BenchmarkStatus =
  | "ok"
  | "no_strategy"
  | "not_configured"
  | "proxy_not_found"
  | "no_prices";

/** `_benchmark_meta`. */
export interface BenchmarkMeta {
  readonly status: BenchmarkStatus;
  readonly message: string | null;
  readonly id: string | null;
  readonly proxy: string | null;
  readonly instrument_id: InstrumentId | null;
  readonly currency: string | null;
}

export function benchmarkMeta(c: ComputedPerformance): BenchmarkMeta {
  const { benchmark: bench, benchmarkInstrument: proxy, strategyState } = c.inputs;
  const base = {
    id: bench === null ? null : bench.id,
    proxy: bench === null ? null : bench.proxy,
    instrument_id: proxy === null ? null : proxy.id,
    currency: proxy === null ? null : proxy.currency,
  };
  if (strategyState === "missing" || strategyState === "invalid") {
    return {
      status: "no_strategy",
      message: "No usable strategy.yaml: its benchmark section names the comparison.",
      ...base,
    };
  }
  if (bench === null) {
    return { status: "not_configured", message: "The strategy has no benchmark section.", ...base };
  }
  if (proxy === null) {
    return {
      status: "proxy_not_found",
      message:
        `The benchmark proxy ${bench.proxy} could not be resolved: use a market ` +
        "symbol with its market suffix (e.g. IUSQ.DE, VWCE.DE), which is registered as a " +
        "reference instrument automatically, or the ISIN of an instrument already known; a " +
        "symbol without a suffix is probed by `cashu invest backfill`.",
      ...base,
    };
  }
  if (c.benchPrices === null) {
    return {
      status: "no_prices",
      message: `No usable prices of ${bench.proxy} yet: run \`cashu invest backfill\`.`,
      ...base,
    };
  }
  return { status: "ok", message: null, ...base };
}

/** `_label`. */
export interface InstrumentLabel {
  readonly instrument_id: InstrumentId;
  readonly label: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly asset_class: string | null;
  readonly isin: string | null;
  readonly valuation_mode: string | null;
}

function label(c: ComputedPerformance, instrumentId: InstrumentId): InstrumentLabel {
  const i = c.inputs.instruments.get(instrumentId);
  if (i === undefined) {
    return {
      instrument_id: instrumentId,
      label: instrumentId,
      symbol: null,
      name: null,
      asset_class: null,
      isin: null,
      valuation_mode: null,
    };
  }
  return {
    instrument_id: instrumentId,
    label: instrumentLabel(i),
    symbol: i.symbol,
    name: i.name,
    asset_class: i.assetClass,
    isin: i.isin,
    valuation_mode: i.valuationMode,
  };
}

/** One data-quality note: a stable `code` with its `params` (the UI labels it), English `message`. */
export interface DataQualityNote {
  readonly code:
    | "incomplete_days"
    | "implied_funding"
    | "price_scale_inferred"
    | "unknown_flows"
    | "benchmark_partial"
    | "benchmark_stale";
  readonly params: Readonly<Record<string, number | string | null>>;
  readonly message: string;
}

export interface PriceScaleView extends InstrumentLabel {
  readonly until: CalendarDate;
  /** Python `str(Fraction)`. */
  readonly factor: string;
}

export interface DataQuality {
  readonly incomplete_days: number;
  readonly end_complete: boolean;
  readonly implied_funding: number | null;
  readonly unknown_flows: number;
  readonly price_scales: readonly PriceScaleView[];
  readonly price_mismatches: number; // float-ok: a count (Python int)
  readonly newest_price: CalendarDate | null;
  readonly benchmark_newest_price: CalendarDate | null;
  readonly notes: readonly DataQualityNote[];
}

/** Python `min` / `max` of ISO dates. */
const earlier = (a: string, b: string): string => (b < a ? b : a);
const later = (a: string, b: string): string => (b > a ? b : a);

/** Python `str(Fraction)`: `n` or `n/d`. */
function fractionStr(f: Fraction): string {
  return f.denominator === 1n ? `${f.numerator}` : `${f.numerator}/${f.denominator}`;
}

/** `_data_quality`. */
function dataQuality(
  c: ComputedPerformance,
  metrics: RangeMetrics,
  bench: BenchmarkView,
): DataQuality {
  const series = c.series;
  const summary = metrics.summary;
  const held = new Set(
    [...(series.captures.get(c.end)?.values() ?? [])].map((v) => v.instrumentId),
  );
  const newest = [...held]
    .map((i) => series.lastBarDates.get(i))
    .filter((d): d is CalendarDate => d !== undefined);
  const notes: DataQualityNote[] = [];
  if (summary.incompleteDays) {
    notes.push({
      code: "incomplete_days",
      params: { days: summary.incompleteDays },
      message:
        `${summary.incompleteDays} day(s) could not be valued in full (a ` +
        "price, an FX rate or a manual valuation is missing); returns link over them.",
    });
  }
  if (summary.impliedFunding) {
    notes.push({
      code: "implied_funding",
      params: {},
      message:
        "A cash balance went negative (deposits missing from the history): the " +
        "shortfall is counted as a contribution.",
    });
  }
  if (series.priceScales.length > 0) {
    notes.push({
      code: "price_scale_inferred",
      params: { instruments: series.priceScales.length },
      message:
        "Some trade prices sit at a clean multiple of the stored closes (a split " +
        "the history does not book); the closes before those trades were scaled.",
    });
  }
  if (series.unknownFlows.length > 0) {
    notes.push({
      code: "unknown_flows",
      params: { flows: series.unknownFlows.length },
      message:
        `${series.unknownFlows.length} transfer(s) or deposit(s) could not be valued ` +
        "(no FX rate or price) and count as 0.",
    });
  }
  if (bench.status === "ok" && bench.covers_range === false) {
    notes.push({
      code: "benchmark_partial",
      params: { first_date: bench.first_priced },
      message:
        "The benchmark's stored prices start after the range start; the " +
        "simulation starts on its first priced day.",
    });
  }
  const proxyBars = c.inputs.benchmarkBars;
  const benchNewest = proxyBars.length > 0 ? (proxyBars.at(-1)?.date ?? null) : null;
  if (bench.status === "ok" && bench.covers_range_end === false) {
    // the last day both the proxy close and its FX rate were usable, at most the newest bar
    const known = [benchNewest, bench.last_priced].filter(
      (d): d is string => typeof d === "string" && d !== "",
    );
    const last = known.length > 0 ? known.reduce(earlier) : null;
    notes.push({
      code: "benchmark_stale",
      params: { last_date: last },
      message:
        `The benchmark's newest stored price is from ${last === null ? "None" : last}: its ` +
        "figures stop there and no comparison with the portfolio is made for the range.",
    });
  }
  return {
    incomplete_days: summary.incompleteDays,
    end_complete: summary.endComplete,
    implied_funding: money(summary.impliedFunding),
    unknown_flows: series.unknownFlows.length,
    price_scales: series.priceScales.map((p) => ({
      ...label(c, p.instrumentId),
      until: p.until,
      factor: fractionStr(p.factor),
    })),
    price_mismatches: series.priceMismatches.length,
    newest_price: newest.length > 0 ? newest.reduce(later) : null,
    benchmark_newest_price: benchNewest,
    notes,
  };
}

/** `_summary_dict`. */
export interface SummaryView {
  readonly start_value: number | null;
  readonly end_value: number | null;
  readonly net_contributions: number | null;
  readonly deposits: number | null;
  readonly withdrawals: number | null;
  readonly implied_funding: number | null;
  readonly account_fees: number | null; // float-ok: rounded Python float of the view
  readonly pnl: number | null;
  readonly twr: number | null;
  readonly twr_annualized: number | null;
  readonly xirr: number | null;
  readonly mwr: number | null;
  readonly max_drawdown: DrawdownView | null;
  readonly days: number;
}

function summaryOut(summary: RangeSummary): SummaryView {
  return {
    start_value: money(summary.startValue),
    end_value: money(summary.endValue),
    net_contributions: money(summary.netContributions),
    deposits: money(summary.deposits),
    withdrawals: money(summary.withdrawals),
    implied_funding: money(summary.impliedFunding),
    account_fees: money(summary.accountFees),
    pnl: money(summary.pnl),
    twr: ratio(summary.twr),
    twr_annualized: ratio(summary.twrAnnualized),
    xirr: ratio(summary.xirr),
    mwr: ratio(summary.mwr),
    max_drawdown: drawdownOut(summary.maxDrawdown),
    days: summary.days,
  };
}

export interface SimulationView {
  readonly end_value: number | null;
  readonly end_value_with_fees: number | null; // float-ok: rounded Python float of the view
  readonly pnl: number | null;
  readonly xirr: number | null;
  readonly mwr: number | null;
  readonly started: CalendarDate | null;
  readonly capped: boolean;
}

/** `_benchmark_dict`: the meta plus the range's benchmark figures (all null unless `ok`). */
export interface BenchmarkView extends BenchmarkMeta {
  readonly first_priced: CalendarDate | null;
  readonly covers_range: boolean | null;
  readonly last_priced: CalendarDate | null;
  readonly covers_range_end: boolean | null;
  readonly twr: number | null;
  readonly twr_annualized: number | null;
  readonly max_drawdown: DrawdownView | null;
  readonly simulation: SimulationView | null;
  readonly excess_twr: number | null;
  readonly excess_value: number | null;
  readonly excess_vs_simulation: number | null;
}

function benchmarkOut(meta: BenchmarkMeta, metrics: RangeMetrics | null): BenchmarkView {
  const b = metrics?.benchmark ?? null;
  if (meta.status !== "ok" || b === null) {
    return {
      ...meta,
      first_priced: null,
      covers_range: null,
      last_priced: null,
      covers_range_end: null,
      twr: null,
      twr_annualized: null,
      max_drawdown: null,
      simulation: null,
      excess_twr: null,
      excess_value: null,
      excess_vs_simulation: null,
    };
  }
  return {
    ...meta,
    first_priced: b.firstPriced,
    covers_range: b.coversRange,
    last_priced: b.lastPriced,
    covers_range_end: b.coversRangeEnd,
    twr: ratio(b.twr),
    twr_annualized: ratio(b.twrAnnualized),
    max_drawdown: drawdownOut(b.maxDrawdown),
    simulation: {
      end_value: money(b.simulationEndValue),
      end_value_with_fees: money(b.simulationEndValueWithFees),
      pnl: money(b.simulationPnl),
      xirr: ratio(b.simulationXirr),
      mwr: ratio(b.simulationMwr),
      started: b.simulationStarted,
      capped: b.simulationCapped,
    },
    excess_twr: ratio(b.excessTwr),
    excess_value: money(b.excessValue),
    excess_vs_simulation: ratio(b.excessVsSimulation),
  };
}

export interface PerformancePoint {
  readonly date: CalendarDate;
  readonly value: number | null;
  readonly contributions: number | null;
  readonly flow: number | null;
  readonly twr: number | null;
  readonly drawdown: number | null;
  readonly benchmark: number | null;
  readonly benchmark_drawdown: number | null;
  readonly simulated_value: number | null;
  readonly complete: boolean;
}

export interface AccountPerformance {
  readonly account_id: AccountId;
  readonly name: string | null;
  readonly currency: string | null;
  readonly values: readonly (number | null)[];
  readonly summary: SummaryView;
}

export interface RollingView {
  readonly months: number;
  readonly points: readonly {
    readonly date: CalendarDate;
    readonly portfolio: number | null;
    readonly benchmark: number | null;
    readonly excess: number | null;
  }[];
  readonly windows: number;
  readonly latest_excess: number | null;
  readonly min_excess: number | null;
  readonly max_excess: number | null;
  readonly share_outperforming: number | null;
}

/** `performance_view`. */
export interface PerformanceView {
  readonly as_of: CalendarDate;
  readonly base_currency: string;
  readonly range: RangeKey;
  readonly start: CalendarDate | null;
  readonly end: CalendarDate;
  readonly accounts_filter: readonly AccountId[] | null;
  readonly step: SampleStep;
  readonly points: readonly PerformancePoint[];
  readonly summary: SummaryView | null;
  readonly benchmark: BenchmarkView;
  readonly rolling: readonly RollingView[];
  readonly accounts: readonly AccountPerformance[];
  readonly data_quality: DataQuality | null;
}

/** The accounts a view is limited to (`service._scope`); null = every account. */
export type AccountScope = readonly AccountId[] | null;

const scopeOf = (accounts: AccountScope): ReadonlySet<AccountId> | null =>
  accounts === null ? null : new Set(accounts);

/** `service._range_metrics`. */
function rangeMetrics(c: ComputedPerformance, key: RangeKey, scope: ReadonlySet<AccountId> | null) {
  const combined = combineSeries(c.series, scope);
  return { metrics: computeRange(key, c.series.dates, combined, c.benchPrices), combined };
}

/** `performance_view(range_key=key, account_ids=accounts)` over a computed performance. */
export function performanceView(
  c: ComputedPerformance,
  key: RangeKey,
  accounts: AccountScope = null,
): PerformanceView {
  const meta = benchmarkMeta(c);
  if (!hasHistory(c)) {
    return {
      as_of: c.end,
      base_currency: c.inputs.base,
      range: key,
      start: null,
      end: c.end,
      accounts_filter: accounts,
      step: "day",
      points: [],
      summary: null,
      benchmark: benchmarkOut(meta, null),
      rolling: [],
      accounts: [],
      data_quality: null,
    };
  }
  const scope = scopeOf(accounts);
  const { metrics, combined } = rangeMetrics(c, key, scope);
  const [step, picked] = sample(metrics.dates);

  const contributions: number[] = [];
  let running = metrics.values[0] as number;
  metrics.flows.forEach((f, i) => {
    if (i > 0) running += f;
    contributions.push(running);
  });
  const points: PerformancePoint[] = [];
  let prev = 0;
  picked.forEach((i, k) => {
    const flow = k > 0 ? pySum(metrics.flows.slice(prev + 1, i + 1)) : 0.0;
    prev = i;
    const twr = metrics.twr[i] ?? null;
    const bindex = metrics.benchmarkIndex === null ? null : (metrics.benchmarkIndex[i] ?? null);
    const sim = metrics.simulation === null ? null : (metrics.simulation.values[i] ?? null);
    points.push({
      date: metrics.dates[i] as CalendarDate,
      value: money(metrics.values[i] as number),
      contributions: money(contributions[i] as number),
      flow: money(flow),
      twr: twr === null ? null : ratio(twr - 1),
      drawdown: ratio(metrics.drawdown[i] ?? null),
      benchmark: bindex === null ? null : ratio(bindex - 1),
      benchmark_drawdown:
        metrics.benchmarkDrawdown === null ? null : ratio(metrics.benchmarkDrawdown[i] ?? null),
      simulated_value: money(sim),
      complete: metrics.complete[i] as boolean,
    });
  });

  const offset = seriesIndexOf(c.series, rangeStart(metrics));
  const names = new Map(c.inputs.accounts.map((a) => [a.id, a] as const));
  const accountRows: AccountPerformance[] = [];
  for (const [accountId, accSeries] of c.series.accounts) {
    if (scope !== null && !scope.has(accountId)) continue;
    const single = combineSeries(c.series, new Set([accountId]));
    const accMetrics = computeRange(key, c.series.dates, single, null);
    const acc = names.get(accountId);
    accountRows.push({
      account_id: accountId,
      name: acc === undefined ? null : acc.name,
      currency: acc === undefined ? null : acc.currency,
      values: picked.map((i) => money(accSeries.values[offset + i] as Decimal)),
      summary: summaryOut(accMetrics.summary),
    });
  }

  const fullTwr = twrIndex(combined.values, combined.flows, combined.complete);
  const rollingRows: RollingView[] = ROLLING_MONTHS.map((months) => {
    const windows = rolling(
      c.series.dates,
      combined,
      fullTwr,
      c.benchPrices,
      months,
      rangeStart(metrics),
    );
    const summary = rollingSummary(windows);
    return {
      months,
      points: windows.map((p) => ({
        date: p.date,
        portfolio: ratio(p.portfolio),
        benchmark: ratio(p.benchmark),
        excess: ratio(p.excess),
      })),
      windows: summary.windows,
      latest_excess: summary.latest === null ? null : ratio(summary.latest.excess),
      min_excess: ratio(summary.minExcess),
      max_excess: ratio(summary.maxExcess),
      share_outperforming: ratio(summary.shareOutperforming),
    };
  });

  const bench = benchmarkOut(meta, metrics);
  return {
    as_of: c.end,
    base_currency: c.inputs.base,
    range: key,
    start: rangeStart(metrics),
    end: rangeEnd(metrics),
    accounts_filter: accounts,
    step,
    points,
    summary: summaryOut(metrics.summary),
    benchmark: bench,
    rolling: rollingRows,
    accounts: accountRows,
    data_quality: dataQuality(c, metrics, bench),
  };
}

export interface AttributionRow extends InstrumentLabel {
  readonly bucket: string;
  readonly held: boolean;
  readonly start_value: number | null;
  readonly end_value: number | null;
  readonly invested: number | null;
  readonly returned: number | null;
  readonly income: number | null; // float-ok: rounded Python float of the view
  readonly costs: number | null; // float-ok: rounded Python float of the view
  readonly pnl: number | null;
  readonly share_of_pnl: number | null;
  readonly unvalued: boolean;
}

/** `attribution_view`. */
export interface AttributionView {
  readonly as_of: CalendarDate;
  readonly base_currency: string;
  readonly range: RangeKey;
  readonly start: CalendarDate | null;
  readonly end: CalendarDate;
  readonly accounts_filter: readonly AccountId[] | null;
  readonly grouping: "strategy_buckets" | "asset_class";
  readonly total_pnl: number | null; // float-ok: rounded Python float of the view
  readonly instruments_pnl: number | null;
  readonly instruments: readonly AttributionRow[];
  readonly buckets: readonly {
    readonly bucket: string;
    readonly pnl: number | null;
    readonly share_of_pnl: number | null;
    readonly instruments: number;
  }[];
  readonly account_level: {
    readonly interest: number | null; // float-ok: rounded Python float of the view
    readonly fees: number | null; // float-ok: rounded Python float of the view
    readonly taxes: number | null; // float-ok: rounded Python float of the view
    readonly fx_conversions: number | null;
    readonly other_income: number | null; // float-ok: rounded Python float of the view
    readonly total: number | null; // float-ok: rounded Python float of the view
  } | null;
  readonly other: number | null;
  readonly concentration: {
    readonly positive_instruments: number;
    readonly negative_instruments: number;
    readonly top: readonly { readonly n: number; readonly share: number | null }[];
    readonly top2: readonly InstrumentLabel[];
    readonly pnl_without_top2: number | null;
    readonly contributions_gross: number | null; // float-ok: rounded Python float of the view
    readonly pnl_pct_of_contributions: number | null;
    readonly pnl_without_top2_pct_of_contributions: number | null;
    readonly benchmark_pnl: number | null;
    readonly benchmark_pnl_pct_of_contributions: number | null;
  } | null;
  readonly data_quality: {
    readonly unvalued_instruments: number;
    readonly unknown_cash: number; // float-ok: a count (Python int)
  } | null;
}

/** `service._attribution`. */
function attributionOf(
  c: ComputedPerformance,
  metrics: RangeMetrics,
  scope: ReadonlySet<AccountId> | null,
) {
  const start = rangeStart(metrics);
  const end = rangeEnd(metrics);
  return attribute(c.inputs.txns, {
    start,
    end,
    startValues: c.series.captures.get(start) ?? new Map(),
    endValues: c.series.captures.get(end) ?? new Map(),
    txnValues: c.series.txnValues,
    fx: c.inputs.fx,
    base: c.inputs.base,
    renames: new Renames(c.inputs.renames),
    accountIds: scope,
  });
}

/** `attribution_view(range_key=key, account_ids=accounts)` over a computed performance. */
export function attributionView(
  c: ComputedPerformance,
  key: RangeKey,
  accounts: AccountScope = null,
): AttributionView {
  const { inputs } = c;
  const grouping =
    inputs.plan !== null && inputs.plan.buckets.length > 0 ? "strategy_buckets" : "asset_class";
  if (!hasHistory(c)) {
    return {
      as_of: c.end,
      base_currency: inputs.base,
      range: key,
      start: null,
      end: c.end,
      accounts_filter: accounts,
      grouping,
      total_pnl: null,
      instruments_pnl: null,
      instruments: [],
      buckets: [],
      account_level: null,
      other: null,
      concentration: null,
      data_quality: null,
    };
  }
  const scope = scopeOf(accounts);
  const { metrics } = rangeMetrics(c, key, scope);
  const result = attributionOf(c, metrics, scope);
  const totalInstruments = instrumentsPnl(result);
  const conc = concentration(result.instruments.map((r) => [r.instrumentId, pnlOf(r)] as const));
  const bucket = (iid: InstrumentId): string =>
    bucketOf(inputs.instruments.get(iid) ?? null, inputs.plan);
  const share = (value: Decimal): number | null =>
    totalInstruments.gt(D("0")) ? ratio(value.div(totalInstruments).toFloat()) : null;

  const rows = result.instruments.map((r) => {
    const pnl = pnlOf(r);
    return {
      ...label(c, r.instrumentId),
      bucket: bucket(r.instrumentId),
      held: r.held,
      start_value: money(r.startValue),
      end_value: money(r.endValue),
      invested: money(r.invested),
      returned: money(r.returned),
      income: money(r.income),
      costs: money(r.costs),
      pnl: money(pnl),
      share_of_pnl: share(pnl),
      unvalued: r.unvalued,
    };
  });
  const buckets = groupByBucket(result.instruments, bucket).map(([b, p, n]) => ({
    bucket: b,
    pnl: money(p),
    share_of_pnl: share(p),
    instruments: n,
  }));
  const summary = metrics.summary;
  const total = summary.pnl;
  const level = result.accountLevel;
  const levelTotal = accountLevelTotal(level);
  const gross = summary.contributionsGross;
  const benchPnl = metrics.benchmark === null ? null : metrics.benchmark.simulationPnl;
  const ofContributions = (value: number | null): number | null =>
    value === null || !gross || gross <= 0 ? null : ratio(value / gross);

  return {
    as_of: c.end,
    base_currency: inputs.base,
    range: key,
    start: rangeStart(metrics),
    end: rangeEnd(metrics),
    accounts_filter: accounts,
    grouping,
    total_pnl: money(total),
    instruments_pnl: money(totalInstruments),
    instruments: rows,
    buckets,
    account_level: {
      interest: money(level.interest),
      fees: money(level.fees),
      taxes: money(level.taxes),
      fx_conversions: money(level.fxConversions),
      other_income: money(level.otherIncome),
      total: money(levelTotal),
    },
    // Python: Decimal(str(total)) - total_instruments - level.total, in the default context
    other: money(D(floatRepr(total)).sub(totalInstruments).sub(levelTotal)),
    concentration: {
      positive_instruments: conc.positive,
      negative_instruments: conc.negative,
      top: conc.topShares.map(([n, sh]) => ({ n, share: ratio(sh) })),
      top2: conc.top2.map((i) => label(c, i)),
      pnl_without_top2: money(conc.pnlWithoutTop2),
      contributions_gross: money(gross),
      pnl_pct_of_contributions: ofContributions(total),
      pnl_without_top2_pct_of_contributions: ofContributions(conc.pnlWithoutTop2.toFloat()),
      benchmark_pnl: money(benchPnl),
      benchmark_pnl_pct_of_contributions: ofContributions(benchPnl),
    },
    data_quality: {
      unvalued_instruments: result.instruments.filter((r) => r.unvalued).length,
      unknown_cash: result.unknownCash,
    },
  };
}

/** `mcp_summary`: plain values for the MCP `history_metrics` tool (whole history, every account). */
export interface HistoryMetrics {
  /** The first day with history (the series' second day). */
  readonly since: CalendarDate;
  readonly asOf: CalendarDate;
  readonly baseCurrency: string;
  readonly summary: RangeSummary;
  readonly benchmarkMeta: BenchmarkMeta;
  /** The range's benchmark figures; null unless the benchmark is `ok` (Python `{}`). */
  readonly benchmark: RangeBenchmark | null;
  readonly concentration: Concentration;
  readonly pnlPctOfContributions: number | null;
  readonly withoutTop2PctOfContributions: number | null;
  readonly benchmarkPnlPctOfContributions: number | null;
  readonly rolling: readonly ({ readonly months: number } & RollingSummary)[];
  readonly perYear: readonly YearReturn[];
}

/** `mcp_summary(...)` over a computed performance; null without investments history. */
export function historyMetrics(c: ComputedPerformance): HistoryMetrics | null {
  if (!hasHistory(c)) return null;
  const { metrics, combined } = rangeMetrics(c, "max", null);
  const meta = benchmarkMeta(c);
  const bench = meta.status === "ok" ? metrics.benchmark : null;
  const result = attributionOf(c, metrics, null);
  const conc = concentration(result.instruments.map((r) => [r.instrumentId, pnlOf(r)] as const));
  const gross = metrics.summary.contributionsGross;
  const ofContributions = (value: number | null): number | null =>
    value === null || !gross || gross <= 0 ? null : value / gross;
  const fullTwr = twrIndex(combined.values, combined.flows, combined.complete);
  return {
    since: (metrics.dates.length > 1 ? metrics.dates[1] : metrics.dates[0]) as CalendarDate,
    asOf: c.end,
    baseCurrency: c.inputs.base,
    summary: metrics.summary,
    benchmarkMeta: meta,
    benchmark: bench,
    concentration: conc,
    pnlPctOfContributions: ofContributions(metrics.summary.pnl),
    withoutTop2PctOfContributions: ofContributions(conc.pnlWithoutTop2.toFloat()),
    benchmarkPnlPctOfContributions: ofContributions(bench?.simulationPnl ?? null),
    rolling: ROLLING_MONTHS.map((months) => ({
      months,
      ...rollingSummary(rolling(c.series.dates, combined, fullTwr, c.benchPrices, months)),
    })),
    perYear: perYear(c.series.dates, fullTwr, c.benchPrices),
  };
}
