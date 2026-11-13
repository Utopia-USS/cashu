// The Investments tab's Portfolio view: the value converted to the base currency (with today's and the
// week's change, the foreign positions and the NBP table), the 12-month chart, the facts (this year, from
// the 12-month high, the gain so far, the money added this year against the monthly plan), allocation
// against the strategy's targets (only while every bucket is generic, under its shared label, as the
// desktop: the owner's own buckets, their targets and drift never show, F7) and the positions with
// their week and result. Two reads of the portfolio
// query: one month (the day's and the week's change) and one year (the chart, this year, the high).
import { addDays, D, Decimal, type IsoDate, Money, ZERO } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { pricesFetchedAt } from "@cashu/store/device";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { allocGeneric } from "@cashu/ui-logic/investments/buckets";
import { bucketDisplayName } from "@cashu/ui-logic/investments/labels";
import { useState } from "react";
import { useServices } from "../../../services/ServicesProvider";
import { useNow } from "../../../shell/useNow";
import { localToday } from "../../screenContext";
import { monthYear, uiLang, weekdayDayMonth } from "../format";
import type {
  AllocationColor,
  PortfolioPosition,
  PortfolioViewProps,
} from "../investments-contracts";
import { useInvestmentSignals, waitsForDecision } from "../useInvestmentSignals";
import { S } from "./Portfolio.strings";

type Portfolio = ReturnType<
  ReturnType<typeof useServices>["moneyQueries"]["investments"]["portfolio"]["run"]
>;
type ReadyPortfolio = Extract<Portfolio, { status: "ready" }>;
type RawPoint = ReadyPortfolio["performance"]["points"][number];
/** A valued point of a performance series (points without a value or TWR are left out). */
interface PerfPoint {
  readonly date: string;
  readonly value: number;
  readonly twr: number;
  readonly flow: number;
  readonly drawdown: number;
}

function valued(points: readonly RawPoint[]): PerfPoint[] {
  return points.flatMap((p) =>
    p.value === null || p.twr === null
      ? []
      : [
          {
            date: p.date,
            value: p.value,
            twr: p.twr,
            flow: p.flow ?? 0,
            drawdown: p.drawdown ?? 0,
          },
        ],
  );
}

/** The chart's points: one a week over the year, newest last. */
const CHART_WEEKS = 52;
/** A drift under this many percentage points reads as on target. */
const ON_TARGET_PP = 1;

/** A float share from the store as an exact Decimal ratio for the value components. */
const ratio = (x: number): Decimal => Decimal.fromFloat(x);

/** Market change between two points of one performance series: money without the flows, TWR ratio. */
function moveBetween(a: PerfPoint, b: PerfPoint, flows: number) {
  return {
    money: b.value - a.value - flows,
    pct: (1 + b.twr) / (1 + a.twr) - 1,
  };
}

/** The last point on or before `date`, or null. */
function pointAt<T extends { readonly date: string }>(
  points: readonly T[],
  date: IsoDate,
): T | null {
  let found: T | null = null;
  for (const p of points) if (p.date <= date) found = p;
  return found;
}

/** The week's move of a position from its recent closes (oldest first). */
function weekOf(closes: readonly { readonly date: string; readonly close: Decimal }[]) {
  const last = closes.at(-1);
  if (last === undefined) return null;
  const base = pointAt(closes, addDays(last.date as IsoDate, -7));
  if (base === null || base.close.isZero()) return null;
  return last.close.div(base.close).sub(D("1"));
}

/** Weekly samples of a daily (or weekly) series, newest last. */
function weekly(points: readonly PerfPoint[]): PerfPoint[] {
  const picked: PerfPoint[] = [];
  for (let i = points.length - 1; i >= 0 && picked.length < CHART_WEEKS; i--) {
    const p = points[i] as PerfPoint;
    const newer = picked.at(-1);
    if (newer === undefined || p.date <= addDays(newer.date as IsoDate, -7)) picked.push(p);
  }
  return picked.reverse();
}

function bucketColor(id: string): AllocationColor {
  if (id === "cash") return "inv-cash";
  if (/bond|treasury/.test(id)) return "inv-bonds";
  if (/(^|_)(pl|polish)(_|$)/.test(id)) return "inv-pl";
  if (/equit|stock|world|global/.test(id)) return "inv-global";
  return "inv-other";
}

/** Months of the year whose plan day has passed by `today` (the plan to date). */
function plannedMonths(today: IsoDate, dayOfMonth: number | null): number {
  const month = Number(today.slice(5, 7));
  const day = Number(today.slice(8, 10));
  return dayOfMonth !== null && day < dayOfMonth ? month - 1 : month;
}

type Allocation = Extract<PortfolioViewProps, { status: "ready" }>["allocation"];

/**
 * Allocation against the strategy's targets, only while every bucket is generic (the desktop's
 * `allocGeneric`); otherwise neither the rows nor the drift status show (F7). Exported for its test.
 */
export function allocationProps(allocation: {
  readonly buckets: readonly {
    readonly bucket_id: string;
    readonly generic?: boolean | null;
    readonly weight: number | null;
    readonly target: number | null;
    readonly drift_pp: number | null;
  }[];
  readonly buckets_generic?: boolean | null;
  readonly unclassified: { readonly weight: number | null } | null;
}): Allocation {
  const buckets = allocGeneric(allocation) ? allocation.buckets : [];
  const rows: Allocation["rows"][number][] = buckets.map((b) => ({
    key: b.bucket_id,
    label: bucketDisplayName(b.bucket_id),
    now: ratio(b.weight ?? 0),
    target: b.target === null ? null : ratio(b.target),
    color: bucketColor(b.bucket_id),
  }));
  const unclassified = allocation.unclassified;
  if (buckets.length > 0 && unclassified !== null && (unclassified.weight ?? 0) > 0)
    rows.push({
      key: "unbucketed",
      label: S.unbucketed,
      now: ratio(unclassified.weight ?? 0),
      target: null,
      color: "inv-other",
    });
  const worst = buckets
    .filter((b) => b.target !== null && b.drift_pp !== null)
    .reduce<(typeof buckets)[number] | null>(
      (w, b) => (w === null || Math.abs(b.drift_pp ?? 0) > Math.abs(w.drift_pp ?? 0) ? b : w),
      null,
    );
  const drift =
    worst === null
      ? null
      : Math.abs(worst.drift_pp ?? 0) < ON_TARGET_PP
        ? { label: S.onTarget, tone: "ok" as const }
        : {
            label: ((worst.drift_pp ?? 0) < 0 ? S.below : S.above)(
              bucketDisplayName(worst.bucket_id),
              `${Math.round(Math.abs(worst.drift_pp ?? 0))}%`,
            ),
            tone: "warn" as const,
          };
  return { rows, drift };
}

function portfolioProps(
  month: Portfolio,
  year: Portfolio,
  input: {
    readonly today: IsoDate;
    /** When this phone last fetched the vault's prices itself (an ISO instant), null if never. */
    readonly fetchedAt: string | null;
    readonly locale: string;
    /** Instruments with an open action signal waiting for a decision. */
    readonly risky: ReadonlySet<string>;
    readonly account: string | null;
    readonly onAccountPicked: (gid: string | null) => void;
    readonly onPositionPressed: (gid: string) => void;
  },
): PortfolioViewProps {
  // The phone's strategy source is always current for its own vault (a vault without a synced strategy,
  // or with an invalid one, reads as a missing / invalid state, not as unavailable), so an unavailable
  // read is the clock, the market or the vault identity: one message covers them.
  if (month.status !== "ready" || year.status !== "ready")
    return { status: "unavailable", message: S.unavailable };
  const { locale, today } = input;
  const base = month.overview.base_currency;
  const money = (amount: Decimal) => new Money(amount, base);
  const display = (value: number) =>
    formatDecimalValue(Decimal.fromFloat(value), locale, { currency: base, fractionDigits: 0 })
      .text;

  // Today's and this week's change from the month's daily points. Today's change exists only once the
  // phone fetched prices today: before that the last two points are carried prices, not today's move.
  const daily = valued(month.performance.points);
  const last = daily.at(-1);
  const before = daily.at(-2);
  const fetchedToday = input.fetchedAt !== null && localToday(new Date(input.fetchedAt)) === today;
  const day =
    fetchedToday && last !== undefined && before !== undefined
      ? moveBetween(before, last, last.flow)
      : null;
  const weekBase = last === undefined ? null : pointAt(daily, addDays(last.date as IsoDate, -7));
  const week =
    last !== undefined && weekBase !== null && weekBase !== last
      ? moveBetween(
          weekBase,
          last,
          daily.filter((p) => p.date > weekBase.date).reduce((s, p) => s + p.flow, 0),
        )
      : null;

  // The year: weekly chart, this year's TWR and the distance from the 12-month high.
  const points = valued(year.performance.points);
  const chartPoints = weekly(points);
  const yearEnd = points.at(-1);
  const yearStart = pointAt(points, `${Number(today.slice(0, 4)) - 1}-12-31`) ?? points[0];
  const thisYear =
    yearEnd !== undefined && yearStart !== undefined
      ? ratio((1 + yearEnd.twr) / (1 + yearStart.twr) - 1)
      : null;
  const fromHigh = yearEnd === undefined ? null : ratio(yearEnd.drawdown);
  const max = chartPoints.reduce((m, p) => Math.max(m, Math.abs(p.value)), 0);
  const first = chartPoints[0];
  const newest = chartPoints.at(-1);
  const xIndices = [0, Math.floor((chartPoints.length - 1) / 2), chartPoints.length - 1].filter(
    (i, pos, all) => i >= 0 && all.indexOf(i) === pos,
  );

  // Added this year against the plan.
  const yearKey = today.slice(0, 4);
  const added = month.contributions
    .filter((c) => c.month.startsWith(yearKey))
    .reduce((sum, c) => sum.add(c.amount), ZERO);
  const plan = month.contributionPlan;
  const planToDate =
    plan === null
      ? null
      : money(plan.monthlyAmount.mul(D(String(plannedMonths(today, plan.dayOfMonth ?? null)))));

  const { rows, drift } = allocationProps(month.allocation);

  // Positions, each in its own currency, with the foreign ones listed beside the converted value.
  const incl = new Map<string, Decimal>();
  const positions: PortfolioPosition[] = month.positions.positions.map((p) => {
    const own =
      p.price !== null && p.price_currency !== null && p.price_currency !== base
        ? new Money(p.quantity.mul(p.price), p.price_currency)
        : money(p.value ?? ZERO);
    if (own.currency !== base)
      incl.set(own.currency, (incl.get(own.currency) ?? ZERO).add(own.amount));
    return {
      gid: p.instrument.id,
      name: p.instrument.name || p.instrument.label,
      ticker: p.instrument.symbol ?? p.instrument.label,
      value: own,
      weekPct: weekOf(p.closes_30d),
      resultPct:
        p.valuation_mode === "cost" || p.unrealized_pct === null ? null : ratio(p.unrealized_pct),
      account: p.accounts.map((a) => a.account_name).join(", "),
      risk: input.risky.has(p.instrument.id),
    };
  });
  const rateDate = month.overview.freshness.fx.newest_rate;

  return {
    status: "ready",
    accounts: {
      options: month.accounts.filter((a) => !a.removed).map((a) => ({ gid: a.gid, name: a.name })),
      selected: input.account,
      onPicked: input.onAccountPicked,
    },
    currency: base,
    yearLabel: yearKey,
    value: {
      total: money(month.overview.kpis.value.total),
      day:
        day === null ? null : { amount: money(Decimal.fromFloat(day.money)), pct: ratio(day.pct) },
      weekPct: week === null ? null : ratio(week.pct),
      incl: [...incl].map(([currency, amount]) => new Money(amount, currency)),
      rateDate:
        incl.size === 0 || rateDate === null ? null : weekdayDayMonth(rateDate as IsoDate, locale),
    },
    chart: {
      label: S.chart,
      valueKind: "amount",
      yFormat: false,
      height: 74,
      series: [
        {
          name: S.value,
          area: true,
          values: chartPoints.map((p) => (max === 0 ? 0 : p.value / max)),
          accessibleSummary:
            first !== undefined && newest !== undefined
              ? S.chartSummary(first.date, display(first.value), newest.date, display(newest.value))
              : S.noHistory,
        },
      ],
      xLabels: xIndices.map((i) => {
        const point = chartPoints[i];
        return { i, text: point === undefined ? "" : monthYear(point.date as IsoDate, locale) };
      }),
      tooltip: (i) => {
        const point = chartPoints[i];
        return {
          title: point?.date ?? "",
          rows: point ? [{ name: S.value, value: display(point.value), amount: true }] : [],
        };
      },
    },
    facts: {
      thisYear,
      fromHigh,
      unrealized: money(month.overview.kpis.unrealized.amount ?? ZERO),
      added: money(added),
      planToDate,
    },
    allocation: { rows, drift },
    positions,
    pricesStale: month.overview.freshness.prices.stale_count,
    onPositionPressed: input.onPositionPressed,
  };
}

export function usePortfolioSection(args: {
  readonly openPosition: (gid: string) => void;
}): PortfolioViewProps {
  const { locale } = useUiEnv();
  const { moneyQueries } = useServices();
  const { today } = useNow();
  const [account, setAccount] = useState<string | null>(null);
  const lang = uiLang(locale);
  const month = useQuery(moneyQueries.investments.portfolio, {
    today,
    lang,
    account,
    range: "1m",
  });
  const year = useQuery(moneyQueries.investments.portfolio, { today, lang, account, range: "1y" });
  const fetchedAt = useQuery(pricesFetchedAt, { vault: useProfile() });
  const signals = useInvestmentSignals();
  const risky = new Set(
    signals.status === "ready"
      ? signals.open.flatMap((s) =>
          waitsForDecision(s) && s.instrument !== null ? [s.instrument] : [],
        )
      : [],
  );
  return portfolioProps(month, year, {
    today,
    fetchedAt,
    locale,
    risky,
    account,
    onAccountPicked: setAccount,
    onPositionPressed: args.openPosition,
  });
}
