/** Local behavioral retrospective and performance labels. Amounts never leave in either mode. */
import { addDays, D, type Decimal, daysBetween, roundFloatToInt } from "@cashu/domain";
import {
  type CalendarDate,
  type PriceBar,
  type performance,
  realizedPnlBase,
  TxnType,
} from "@cashu/domain/investments";
import * as L from "../privacy/labels.js";
import type { InvestmentHistoryReads } from "../providers/investmentHistoryTypes.js";
import { type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

const HORIZONS = [30, 90, 180] as const;
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = Math.floor(sorted.length / 2);
  const right = sorted[mid];
  if (right === undefined) throw new Error("missing median element");
  return sorted.length % 2 === 1 ? right : ((sorted[mid - 1] ?? right) + right) / 2;
};
const medianDays = (values: readonly number[]) => {
  const value = median(values);
  return value === null ? null : roundFloatToInt(value);
};
function closeOn(bars: readonly PriceBar[], day: CalendarDate): Decimal | null {
  let low = 0,
    high = bars.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const b = bars[mid];
    if (b !== undefined && b.date <= day) low = mid + 1;
    else high = mid;
  }
  const bar = bars[low - 1];
  return bar === undefined || daysBetween(bar.date, day) > 7 ? null : bar.close;
}
/** Python retains the duplicate end date when today itself is a quarter end. */
export function historyQuarterEnds(
  start: CalendarDate,
  end: CalendarDate,
): readonly CalendarDate[] {
  const out: CalendarDate[] = [];
  let year = Number(start.slice(0, 4)),
    q = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
  while (true) {
    const month = q * 3,
      nextYear = year + (month === 12 ? 1 : 0),
      nextMonth = (month % 12) + 1;
    const day = addDays(
      `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}-01`,
      -1,
    );
    if (day > end) break;
    out.push(day);
    q++;
    if (q === 5) {
      year++;
      q = 1;
    }
  }
  out.push(end);
  return out.slice(-40);
}
export function historyMetrics(ctx: ToolContext<NativeToolStore>): L.LabelledTree {
  const reads = ctx.store.investmentHistory;
  if (reads === undefined)
    throw new ToolError("native investment history is unavailable", "unsupported");
  const state = reads.portfolio(ctx.today),
    txns = state.txns;
  if (txns.length === 0)
    return { note: L.fixedText("no investments history yet"), trades: L.count(0) };
  const trades = txns
    .filter((t) => t.type === TxnType.BUY || t.type === TxnType.SELL)
    .sort((a, b) => a.tradeDate.localeCompare(b.tradeDate));
  const dates = [...new Set(trades.map((t) => t.tradeDate))].sort();
  const gaps = dates.slice(1).map((d, i) => daysBetween(dates[i] ?? d, d));
  const years = new Map<number, { deposits: number; withdrawals: number }>();
  for (const t of txns)
    if (t.type === TxnType.DEPOSIT || t.type === TxnType.WITHDRAWAL) {
      const year = Number(t.tradeDate.slice(0, 4)),
        row = years.get(year) ?? { deposits: 0, withdrawals: 0 };
      if (t.type === TxnType.DEPOSIT) row.deposits++;
      else row.withdrawals++;
      years.set(year, row);
    }
  let sellsChecked = 0,
    sellsAfterDd = 0,
    buysChecked = 0,
    buysAfterRunup = 0;
  const drawdowns: number[] = [],
    afterSale = new Map<number, number[]>(HORIZONS.map((h) => [h, []]));
  for (const t of trades) {
    const bars = t.instrumentId === null ? [] : (state.historyBars.get(t.instrumentId) ?? []);
    const close = closeOn(bars, t.tradeDate);
    if (close === null || close.lte(D("0"))) continue;
    if (t.type === TxnType.SELL) {
      const window = bars.filter(
        (b) => addDays(t.tradeDate, -365) <= b.date && b.date <= t.tradeDate,
      );
      if (window.length > 0) {
        let high = window[0]?.close ?? close;
        for (const b of window) if (b.close.gt(high)) high = b.close;
        const dd = high.isZero() ? 0 : D("1").sub(close.div(high)).toFloat();
        drawdowns.push(dd);
        sellsChecked++;
        if (dd >= 0.15) sellsAfterDd++;
      }
      for (const h of HORIZONS) {
        const day = addDays(t.tradeDate, h);
        if (day > ctx.today) continue;
        const later = closeOn(bars, day);
        if (later !== null) afterSale.get(h)?.push(later.div(close).sub(D("1")).toFloat());
      }
    } else {
      const before = closeOn(bars, addDays(t.tradeDate, -90));
      if (before?.gt(D("0"))) {
        buysChecked++;
        if (close.div(before).sub(D("1")).toFloat() >= 0.2) buysAfterRunup++;
      }
    }
  }
  const winners: number[] = [],
    losers: number[] = [];
  for (const r of state.valued.realized) {
    const pnl = realizedPnlBase(r) ?? r.trade.pnl;
    if (pnl === null) continue;
    (pnl.gt(D("0")) ? winners : losers).push(daysBetween(r.trade.openDate, r.trade.closeDate));
  }
  const fees = new Map<string, { fee: Decimal; gross: Decimal }>();
  for (const t of trades) {
    const row = fees.get(t.currency) ?? { fee: D("0"), gross: D("0") };
    row.fee = row.fee.add(t.fee ?? D("0"));
    row.gross = row.gross.add(t.grossAmount ?? D("0"));
    fees.set(t.currency, row);
  }
  const first = dates[0] ?? txns.map((t) => t.tradeDate).sort()[0] ?? ctx.today;
  const concentration = historyQuarterEnds(first, ctx.today).map((day) => {
    const weights = reads
      .portfolio(day)
      .valued.valued.map((v) => v.weight)
      .filter((v): v is number => v !== null)
      .sort((a, b) => b - a);
    return {
      date: L.date(day),
      positions: L.count(weights.length),
      largest: L.pct(weights[0] ?? null),
      top3: L.pct(weights.length === 0 ? null : weights.slice(0, 3).reduce((a, b) => a + b, 0)),
    };
  });
  return {
    activity: {
      trades: L.count(trades.length),
      first_trade: L.date(dates[0] ?? null),
      last_trade: L.date(dates.at(-1) ?? null),
      days_since_last_trade: L.count(
        dates.at(-1) === undefined ? null : daysBetween(dates.at(-1) ?? ctx.today, ctx.today),
      ),
      median_gap_days: L.count(medianDays(gaps)),
      max_gap_days: L.count(gaps.length === 0 ? null : Math.max(...gaps)),
      gaps_over_90_days: L.count(gaps.filter((g) => g > 90).length),
      gaps_over_180_days: L.count(gaps.filter((g) => g > 180).length),
    },
    deposits_per_year: [...years]
      .sort(([a], [b]) => a - b)
      .map(([year, row]) => ({
        year: L.count(year),
        deposits: L.count(row.deposits),
        withdrawals: L.count(row.withdrawals),
      })),
    sells_after_drawdown: {
      threshold: L.pct(0.15),
      sells_checked: L.count(sellsChecked),
      sells_at_or_below_threshold: L.count(sellsAfterDd),
      median_drawdown_at_sale: L.pct(median(drawdowns)),
    },
    buys_after_runup: {
      threshold: L.pct(0.2),
      lookback_days: L.count(90),
      buys_checked: L.count(buysChecked),
      buys_after_runup: L.count(buysAfterRunup),
    },
    price_after_sales: HORIZONS.map((h) => {
      const changes = afterSale.get(h) ?? [];
      return {
        days: L.count(h),
        sales: L.count(changes.length),
        median_change: L.pct(median(changes)),
        share_rose: L.share(changes.filter((c) => c > 0).length, changes.length),
      };
    }),
    holding_days: {
      winners: L.count(winners.length),
      losers: L.count(losers.length),
      winners_median_days: L.count(medianDays(winners)),
      losers_median_days: L.count(medianDays(losers)),
    },
    fees_pct_of_turnover: [...fees]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, row]) => ({
        currency: L.category(currency),
        fees_share: L.share(row.fee, row.gross),
      })),
    concentration,
    performance: historyPerformance(reads),
  };
}
const safePct = (value: number | null | undefined) =>
  L.pct(
    value === null || value === undefined || !Number.isFinite(value) || Math.abs(value) > 100
      ? null
      : value,
  );
function drawdown(
  prefix: string,
  dd: performance.Drawdown | null | undefined,
): Record<string, L.LabelledTree> {
  return {
    [prefix]: safePct(dd?.depth),
    [`${prefix}_peak`]: L.date(dd?.peak ?? null),
    [`${prefix}_trough`]: L.date(dd?.trough ?? null),
    [`${prefix}_recovered`]: L.date(dd?.recovered ?? null),
  };
}
function historyPerformance(reads: InvestmentHistoryReads): L.LabelledTree {
  let data: performance.HistoryMetrics | null;
  try {
    data = reads.performance();
  } catch {
    return { note: L.fixedText("performance metrics could not be computed") };
  }
  if (data === null) return { note: L.fixedText("no investments history yet") };
  const s = data.summary,
    b = data.benchmark,
    meta = data.benchmarkMeta,
    conc = data.concentration,
    shares = new Map(conc.topShares);
  return {
    since: L.date(data.since),
    as_of: L.date(data.asOf),
    base_currency: L.category(data.baseCurrency),
    return: {
      twr: safePct(s.twr),
      twr_annualized: safePct(s.twrAnnualized),
      xirr: safePct(s.xirr),
      money_weighted: safePct(s.mwr),
      days: L.count(s.days),
    },
    benchmark: {
      id: L.category(meta.id),
      proxy: L.symbol(meta.proxy),
      status: L.category(meta.status),
      covers_history: L.flag(b?.coversRange ?? null),
      covers_to_date: L.flag(b?.coversRangeEnd ?? null),
      last_priced: L.date(b?.lastPriced ?? null),
      twr: safePct(b?.twr),
      twr_annualized: safePct(b?.twrAnnualized),
      simulation_xirr: safePct(b?.simulationXirr),
      simulation_money_weighted: safePct(b?.simulationMwr),
      excess_twr: safePct(b?.excessTwr),
      excess_vs_simulation: safePct(b?.excessVsSimulation),
    },
    max_drawdown: {
      ...drawdown("portfolio", s.maxDrawdown),
      ...drawdown("benchmark", b?.maxDrawdown),
    },
    profit_concentration: {
      instruments_positive: L.count(conc.positive),
      instruments_negative: L.count(conc.negative),
      top1_share: safePct(shares.get(1)),
      top2_share: safePct(shares.get(2)),
      top3_share: safePct(shares.get(3)),
      top5_share: safePct(shares.get(5)),
      pnl_pct_of_contributions: safePct(data.pnlPctOfContributions),
      without_top2_pct_of_contributions: safePct(data.withoutTop2PctOfContributions),
      benchmark_pnl_pct_of_contributions: safePct(data.benchmarkPnlPctOfContributions),
    },
    rolling_relative: data.rolling.map((r) => ({
      months: L.count(r.months),
      windows: L.count(r.windows),
      latest_date: L.date(r.latest?.date ?? null),
      latest_excess: safePct(r.latest?.excess),
      min_excess: safePct(r.minExcess),
      max_excess: safePct(r.maxExcess),
      share_outperforming: safePct(r.shareOutperforming),
    })),
    per_year: data.perYear.map((y) => ({
      year: L.count(y.year),
      portfolio_twr: safePct(y.portfolio),
      benchmark: safePct(y.benchmark),
      partial_year: L.flag(y.partial),
    })),
    data_quality: {
      incomplete_days: L.count(s.incompleteDays),
      implied_funding: L.flag(Boolean(s.impliedFunding)),
    },
    note: L.fixedText(
      "values are fractions, not percent; twr is contributions-neutral, money_weighted and xirr follow the deposits; the benchmark simulation puts the same deposits on the same days into the proxy; excess = portfolio minus benchmark; rolling windows are cumulative, not annualized",
    ),
  };
}
