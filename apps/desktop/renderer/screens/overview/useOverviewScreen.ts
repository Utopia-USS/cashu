import { type IsoDate, Money } from "@cashu/domain";
import { intlLocale, lang } from "@cashu/i18n";
import { formatCalendarDate, formatDecimalValue } from "@cashu/i18n/values";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import type { ChartTip } from "@cashu/ui";
import { S } from "../../Desktop.strings.js";

// Client descriptors carry ids/args only. The trusted host binds the real cache to these ids.
const queries = overviewQueries({ prices: null });

export function useOverviewScreen(args: { today: IsoDate; currency?: string }) {
  const hero = useQuery(queries.hero, { today: args.today });
  const summary = useQuery(queries.summary, { today: args.today });
  const modules = useQuery(queries.moduleStates);
  const series = useQuery(queries.netWorthSeries, {
    today: args.today,
    lang: lang(),
    currency: args.currency ?? hero.facts.currency,
    granularity: "monthly",
    scope: "total",
  });
  const facts = hero.facts;
  const money = (amount: typeof facts.net | null) =>
    amount === null ? null : new Money(amount, facts.currency);
  const locale = intlLocale();
  const display = (amount: typeof facts.net) =>
    formatDecimalValue(amount, locale, { currency: series.currency }).text;
  let low = series.points[0]?.value;
  let high = low;
  for (const point of series.points) {
    if (low === undefined || point.value.lt(low)) low = point.value;
    if (high === undefined || point.value.gt(high)) high = point.value;
  }
  const latest = series.points.at(-1)?.value;
  return {
    today: args.today,
    net: money(facts.net),
    liquid: money(facts.liquid),
    liabilities: money(facts.liabilities),
    homeEquity: money(facts.homeEquity),
    otherCurrencies: Object.entries(facts.otherCurrencies).map(
      ([currency, amount]) => new Money(amount, currency),
    ),
    change: hero.change === null ? null : money(hero.change.change),
    since: hero.change?.since ?? null,
    currencies: [...new Set([facts.currency, ...Object.keys(summary.networth)])].sort(),
    currency: series.currency,
    // Floating point is used only for chart geometry; exact raw money backs the tooltip and values.
    chart: series.points.map((point) => point.value.toFloat()),
    chartSummary:
      latest === undefined || low === undefined || high === undefined
        ? undefined
        : S.exactSeries(display(latest), display(low), display(high)),
    chartTip: (index: number): ChartTip => {
      const point = series.points[index];
      return point === undefined
        ? { title: S.empty, rows: [] }
        : {
            title: formatCalendarDate(point.date, locale),
            rows: [{ name: S.netWorth, value: display(point.value), amount: true }],
          };
    },
    points: series.points.map((point) => ({
      date: point.date,
      value: new Money(point.value, series.currency),
    })),
    modules: modules.filter((module) => module.enabled),
  };
}

export type OverviewScreenState = ReturnType<typeof useOverviewScreen>;
