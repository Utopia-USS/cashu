/**
 * TRANSITIONAL(S19b): the JSON shaping of `performance/service.py` (`performance_view`,
 * `attribution_view` and their helpers) over a computed performance, so the parity producer can write
 * the golden's shape while the service is not ported. Every number comes from the `@cashu/domain`
 * performance core; this file only selects, rounds (`_money` = 2 places, `_ratio` = 6 places, as
 * Python floats) and labels. Replace the calls with the S19b service views and delete this file.
 */

import { D, type Decimal, floatRepr, investments as inv, roundFloat } from "@cashu/domain";
import { type OutValue, pyFloat } from "../output.ts";
import type { Serializer } from "./serialize.ts";

const perf = inv.performance;
type CalendarDate = inv.CalendarDate;

/** What `service.load` read for one profile (the parts the views use). */
export interface LoadedPerformance {
  readonly base: inv.Currency;
  readonly plan: inv.AllocationPlan | null;
  readonly benchmark: { readonly id: string; readonly proxy: string } | null;
  readonly strategyState: string;
  /** The profile's brokerage accounts (id = `str(pk)`), oldest first. */
  readonly accounts: readonly {
    readonly id: string;
    readonly name: string;
    readonly currency: string;
  }[];
  readonly txns: readonly inv.Transaction[];
  readonly renames: readonly inv.InstrumentRename[];
  readonly instruments: ReadonlyMap<inv.InstrumentId, inv.Instrument>;
  readonly fx: inv.FxLookup;
  readonly benchmarkInstrument: inv.Instrument | null;
  readonly benchmarkBars: readonly inv.PriceBar[];
}

/** `service.Computed`. */
export interface ComputedPerformance {
  readonly loaded: LoadedPerformance;
  readonly end: CalendarDate;
  readonly series: inv.performance.PortfolioSeries;
  readonly benchPrices: readonly (number | null)[] | null;
}

type Out = Record<string, OutValue>;

/** `_money`: `round(float(value), 2)`. */
function money(value: number | Decimal | null): OutValue {
  if (value === null) return null;
  return pyFloat(roundFloat(typeof value === "number" ? value : value.toFloat(), 2));
}

/** `_ratio`: `round(float(value), 6)`. */
function ratio(value: number | null): OutValue {
  return value === null ? null : pyFloat(roundFloat(value, 6));
}

const int = (n: number): bigint => BigInt(n);

function drawdownOut(dd: inv.performance.Drawdown | null): OutValue {
  if (dd === null) return null;
  const d = perf.drawdownToDict(dd);
  return { depth: pyFloat(d.depth), peak: d.peak, trough: d.trough, recovered: d.recovered };
}

/** `service.sample`: chart points, daily up to ~13 months, weekly up to ~5 years, month ends beyond. */
export function sample(dates: readonly CalendarDate[]): [string, number[]] {
  const n = dates.length;
  const span = inv.daysBetween(dates[0] as CalendarDate, dates[n - 1] as CalendarDate);
  if (span <= 400) return ["day", Array.from({ length: n }, (_, i) => i)];
  let picked: Set<number>;
  let step: string;
  if (span <= 1900) {
    picked = new Set(Array.from({ length: n }, (_, i) => i).filter((i) => (n - 1 - i) % 7 === 0));
    step = "week";
  } else {
    picked = new Set(perf.monthEndPositions(dates));
    step = "month";
  }
  picked.add(0);
  picked.add(n - 1);
  return [step, [...picked].sort((a, b) => a - b)];
}

/** `_benchmark_meta`. */
function benchmarkMeta(c: ComputedPerformance, s: Serializer): Out {
  const { benchmark: bench, benchmarkInstrument: proxy, strategyState } = c.loaded;
  const meta: Out = {
    status: "ok",
    message: null,
    id: bench === null ? null : bench.id,
    proxy: bench === null ? null : bench.proxy,
    instrument_id: proxy === null ? null : s.instrumentKey(proxy.id),
    currency: proxy === null ? null : proxy.currency,
  };
  if (strategyState === "missing" || strategyState === "invalid") {
    meta.status = "no_strategy";
    meta.message = "No usable strategy.yaml: its benchmark section names the comparison.";
  } else if (bench === null) {
    meta.status = "not_configured";
    meta.message = "The strategy has no benchmark section.";
  } else if (proxy === null) {
    meta.status = "proxy_not_found";
    meta.message =
      `The benchmark proxy ${bench.proxy} could not be resolved: use a market ` +
      "symbol with its market suffix (e.g. IUSQ.DE, VWCE.DE), which is registered as a " +
      "reference instrument automatically, or the ISIN of an instrument already known; a " +
      "symbol without a suffix is probed by `cashu invest backfill`.";
  } else if (c.benchPrices === null) {
    meta.status = "no_prices";
    meta.message = `No usable prices of ${bench.proxy} yet: run \`cashu invest backfill\`.`;
  }
  return meta;
}

/** `_label`. */
function label(c: ComputedPerformance, s: Serializer, instrumentId: inv.InstrumentId): Out {
  const i = c.loaded.instruments.get(instrumentId);
  if (i === undefined) {
    return {
      instrument_id: s.instrumentKey(instrumentId),
      label: instrumentId,
      symbol: null,
      name: null,
      asset_class: null,
      isin: null,
      valuation_mode: null,
    };
  }
  return {
    instrument_id: s.instrumentKey(instrumentId),
    label: inv.instrumentLabel(i),
    symbol: i.symbol,
    name: i.name,
    asset_class: i.assetClass,
    isin: i.isin,
    valuation_mode: i.valuationMode,
  };
}

/** `_data_quality`. */
function dataQuality(
  c: ComputedPerformance,
  s: Serializer,
  metrics: inv.performance.RangeMetrics,
  bench: Out,
): Out {
  const series = c.series;
  const summary = metrics.summary;
  const held = new Set(
    [...(series.captures.get(c.end)?.values() ?? [])].map((v) => v.instrumentId),
  );
  const newest = [...held]
    .map((i) => series.lastBarDates.get(i))
    .filter((d): d is CalendarDate => d !== undefined);
  const notes: Out[] = [];
  if (summary.incompleteDays) {
    notes.push({
      code: "incomplete_days",
      params: { days: int(summary.incompleteDays) },
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
      params: { instruments: int(series.priceScales.length) },
      message:
        "Some trade prices sit at a clean multiple of the stored closes (a split " +
        "the history does not book); the closes before those trades were scaled.",
    });
  }
  if (series.unknownFlows.length > 0) {
    notes.push({
      code: "unknown_flows",
      params: { flows: int(series.unknownFlows.length) },
      message:
        `${series.unknownFlows.length} transfer(s) or deposit(s) could not be valued ` +
        "(no FX rate or price) and count as 0.",
    });
  }
  if (bench.status === "ok" && bench.covers_range === false) {
    notes.push({
      code: "benchmark_partial",
      params: { first_date: bench.first_priced ?? null },
      message:
        "The benchmark's stored prices start after the range start; the " +
        "simulation starts on its first priced day.",
    });
  }
  const barsOfProxy = c.loaded.benchmarkBars;
  const benchNewest =
    barsOfProxy.length > 0 ? (barsOfProxy[barsOfProxy.length - 1] as inv.PriceBar).date : null;
  if (bench.status === "ok" && bench.covers_range_end === false) {
    // the last day both the proxy close and its FX rate were usable, at most the newest bar
    const known = [benchNewest, bench.last_priced as string | null].filter(
      (d): d is string => typeof d === "string" && d !== "",
    );
    const last = known.length > 0 ? known.reduce(earlierDate) : null;
    notes.push({
      code: "benchmark_stale",
      params: { last_date: last },
      message:
        `The benchmark's newest stored price is from ${last === null ? "None" : last}: its figures stop ` +
        "there and no comparison with the portfolio is made for the range.",
    });
  }
  return {
    incomplete_days: int(summary.incompleteDays),
    end_complete: summary.endComplete,
    implied_funding: money(summary.impliedFunding),
    unknown_flows: int(series.unknownFlows.length),
    price_scales: series.priceScales.map((p) => ({
      ...label(c, s, p.instrumentId),
      until: p.until,
      factor: fractionStr(p.factor),
    })),
    price_mismatches: int(series.priceMismatches.length),
    newest_price: newest.length > 0 ? newest.reduce(laterDate) : null,
    benchmark_newest_price: benchNewest,
    notes,
  };
}

/** Python `min` of two ISO dates. */
function earlierDate(a: string, b: string): string {
  if (b < a) return b;
  return a;
}

/** Python `max` of two ISO dates. */
function laterDate(a: string, b: string): string {
  if (b > a) return b;
  return a;
}

/** Python `str(Fraction)`: `n` or `n/d`. */
function fractionStr(f: inv.Fraction): string {
  return f.denominator === 1n ? `${f.numerator}` : `${f.numerator}/${f.denominator}`;
}

/** `_summary_dict`. */
function summaryOut(summary: inv.performance.RangeSummary): Out {
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
    days: int(summary.days),
  };
}

/** `_benchmark_dict`. */
function benchmarkOut(meta: Out, metrics: inv.performance.RangeMetrics | null): Out {
  const out: Out = { ...meta };
  const b = metrics?.benchmark ?? null;
  if (meta.status !== "ok" || b === null) {
    return {
      ...out,
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
    ...out,
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

const hasHistory = (c: ComputedPerformance): boolean => c.loaded.txns.length > 0;

/** `performance_view(range_key=key)` for every account (`accounts_filter` None). */
export function performanceView(
  c: ComputedPerformance,
  s: Serializer,
  key: inv.performance.RangeKey,
): Out {
  const meta = benchmarkMeta(c, s);
  if (!hasHistory(c)) {
    return {
      as_of: c.end,
      base_currency: c.loaded.base,
      range: key,
      start: null,
      end: c.end,
      accounts_filter: null,
      step: "day",
      points: [],
      summary: null,
      benchmark: benchmarkOut(meta, null),
      rolling: [],
      accounts: [],
      data_quality: null,
    };
  }
  const combined = perf.combineSeries(c.series, null);
  const metrics = perf.computeRange(key, c.series.dates, combined, c.benchPrices);
  const [step, picked] = sample(metrics.dates);

  const contributions: number[] = [];
  let running = metrics.values[0] as number;
  metrics.flows.forEach((f, i) => {
    if (i > 0) running += f;
    contributions.push(running);
  });
  const points: Out[] = [];
  let prev = 0;
  picked.forEach((i, k) => {
    const flow = k > 0 ? perf.pySum(metrics.flows.slice(prev + 1, i + 1)) : 0.0;
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

  const offset = perf.seriesIndexOf(c.series, perf.rangeStart(metrics));
  const names = new Map(c.loaded.accounts.map((a) => [a.id, a] as const));
  const accounts: Out[] = [];
  for (const [accountId, accSeries] of c.series.accounts) {
    const single = perf.combineSeries(c.series, new Set([accountId]));
    const accMetrics = perf.computeRange(key, c.series.dates, single, null);
    const acc = names.get(accountId);
    accounts.push({
      account_id: s.account(accountId),
      name: acc === undefined ? null : acc.name,
      currency: acc === undefined ? null : acc.currency,
      values: picked.map((i) => money(accSeries.values[offset + i] as Decimal)),
      summary: summaryOut(accMetrics.summary),
    });
  }

  const fullTwr = perf.twrIndex(combined.values, combined.flows, combined.complete);
  const rolling: Out[] = perf.ROLLING_MONTHS.map((months) => {
    const windows = perf.rolling(
      c.series.dates,
      combined,
      fullTwr,
      c.benchPrices,
      months,
      perf.rangeStart(metrics),
    );
    const summary = perf.rollingSummary(windows);
    return {
      months: int(months),
      points: windows.map((p) => ({
        date: p.date,
        portfolio: ratio(p.portfolio),
        benchmark: ratio(p.benchmark),
        excess: ratio(p.excess),
      })),
      windows: int(summary.windows),
      latest_excess: summary.latest === null ? null : ratio(summary.latest.excess),
      min_excess: ratio(summary.minExcess),
      max_excess: ratio(summary.maxExcess),
      share_outperforming: ratio(summary.shareOutperforming),
    };
  });

  const bench = benchmarkOut(meta, metrics);
  return {
    as_of: c.end,
    base_currency: c.loaded.base,
    range: key,
    start: perf.rangeStart(metrics),
    end: perf.rangeEnd(metrics),
    accounts_filter: null,
    step,
    points,
    summary: summaryOut(metrics.summary),
    benchmark: bench,
    rolling,
    accounts,
    data_quality: dataQuality(c, s, metrics, bench),
  };
}

/** `attribution_view(range_key=key)` for every account. */
export function attributionView(
  c: ComputedPerformance,
  s: Serializer,
  key: inv.performance.RangeKey,
): Out {
  const { loaded } = c;
  const grouping =
    loaded.plan !== null && loaded.plan.buckets.length > 0 ? "strategy_buckets" : "asset_class";
  if (!hasHistory(c)) {
    return {
      as_of: c.end,
      base_currency: loaded.base,
      range: key,
      start: null,
      end: c.end,
      accounts_filter: null,
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
  const combined = perf.combineSeries(c.series, null);
  const metrics = perf.computeRange(key, c.series.dates, combined, c.benchPrices);
  const start = perf.rangeStart(metrics);
  const end = perf.rangeEnd(metrics);
  const result = perf.attribute(loaded.txns, {
    start,
    end,
    startValues: c.series.captures.get(start) ?? new Map(),
    endValues: c.series.captures.get(end) ?? new Map(),
    txnValues: c.series.txnValues,
    fx: loaded.fx,
    base: loaded.base,
    renames: new perf.Renames(loaded.renames),
    accountIds: null,
  });
  const totalInstruments = perf.instrumentsPnl(result);
  const conc = perf.concentration(
    result.instruments.map((r) => [r.instrumentId, perf.pnlOf(r)] as const),
  );
  const bucket = (iid: inv.InstrumentId): string =>
    perf.bucketOf(loaded.instruments.get(iid) ?? null, loaded.plan);
  const share = (value: Decimal): OutValue =>
    totalInstruments.gt(D("0")) ? ratio(value.div(totalInstruments).toFloat()) : null;

  const rows = result.instruments.map((r) => {
    const pnl = perf.pnlOf(r);
    return {
      ...label(c, s, r.instrumentId),
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
  const buckets = perf.groupByBucket(result.instruments, bucket).map(([b, p, n]) => ({
    bucket: b,
    pnl: money(p),
    share_of_pnl: share(p),
    instruments: int(n),
  }));
  const summary = metrics.summary;
  const total = summary.pnl;
  const level = result.accountLevel;
  const levelTotal = perf.accountLevelTotal(level);
  const gross = summary.contributionsGross;
  const benchPnl = metrics.benchmark === null ? null : metrics.benchmark.simulationPnl;
  const ofContributions = (value: number | null): OutValue =>
    value === null || !gross || gross <= 0 ? null : ratio(value / gross);

  return {
    as_of: c.end,
    base_currency: loaded.base,
    range: key,
    start,
    end,
    accounts_filter: null,
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
      positive_instruments: int(conc.positive),
      negative_instruments: int(conc.negative),
      top: conc.topShares.map(([n, sh]) => ({ n: int(n), share: ratio(sh) })),
      top2: conc.top2.map((i) => label(c, s, i)),
      pnl_without_top2: money(conc.pnlWithoutTop2),
      contributions_gross: money(gross),
      pnl_pct_of_contributions: ofContributions(total),
      pnl_without_top2_pct_of_contributions: ofContributions(conc.pnlWithoutTop2.toFloat()),
      benchmark_pnl: money(benchPnl),
      benchmark_pnl_pct_of_contributions: ofContributions(benchPnl),
    },
    data_quality: {
      unvalued_instruments: int(result.instruments.filter((r) => r.unvalued).length),
      unknown_cash: int(result.unknownCash),
    },
  };
}
