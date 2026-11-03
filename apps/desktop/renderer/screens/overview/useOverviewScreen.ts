import { D, type IsoDate, Money } from "@cashu/domain";
import { intlLocale, lang } from "@cashu/i18n";
import { S as N } from "@cashu/i18n/core/overview/NetWorthWidget.strings";
import { formatCalendarDate, formatDecimalValue } from "@cashu/i18n/values";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { type ChartTip, type SeriesColor, useUiEnv } from "@cashu/ui";
import { dm } from "@cashu/ui-logic/investments/labels";
import { useState } from "react";
import { S } from "../../Desktop.strings.js";

// Client descriptors carry ids/args only. The trusted host binds the real cache to these ids.
const queries = overviewQueries({ prices: null });
const STACK_RANK: Readonly<Record<string, number>> = {
  property: 0,
  vehicle: 1,
  money: 2,
  mortgage: 3,
  loan: 4,
};

export function useOverviewScreen(args: { today: IsoDate; vault: string; currency?: string }) {
  const { privacy } = useUiEnv();
  const [chartMode, setChartMode] = useState<"line" | "stacked">("line");
  const [scope, setScope] = useState<"total" | "liquid">("total");
  const [granularity, setGranularity] = useState<"monthly" | "weekly" | "daily">("monthly");
  const [rangeDays, setRangeDays] = useState<number | null>(null);
  const hero = useQuery(queries.hero, { today: args.today });
  const summary = useQuery(queries.summary, { today: args.today });
  const modules = useQuery(queries.moduleStates);
  const budgetSetup = useQuery(queries.moduleSetup, { module: "budget", cli: "", lang: lang() });
  const assetsSetup = useQuery(queries.moduleSetup, { module: "assets", cli: "", lang: lang() });
  const loansSetup = useQuery(queries.moduleSetup, { module: "loans", cli: "", lang: lang() });
  const investmentSetup = useQuery(queries.moduleSetup, {
    module: "investments",
    cli: "",
    lang: lang(),
  });
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const accounts = useQuery(queries.accounts, { today: args.today });
  const budgetWidgets = useQuery(queries.budgetWidgets, { today: args.today });
  const loans = useQuery(queries.loans, { today: args.today });
  const investment = useQuery(queries.investments, { today: args.today, lang: lang() });
  const [showEmptyAccounts, setShowEmptyAccounts] = useState(false);
  const series = useQuery(queries.netWorthSeries, {
    today: args.today,
    lang: lang(),
    currency: args.currency ?? hero.facts.currency,
    granularity,
    scope,
  });
  const annualTotal = useQuery(queries.netWorthSeries, {
    today: args.today,
    lang: lang(),
    currency: args.currency ?? hero.facts.currency,
    granularity: "monthly",
    scope: "total",
  });
  const annualLiquid = useQuery(queries.netWorthSeries, {
    today: args.today,
    lang: lang(),
    currency: args.currency ?? hero.facts.currency,
    granularity: "monthly",
    scope: "liquid",
  });
  const facts = hero.facts;
  const money = (amount: typeof facts.net | null) =>
    amount === null ? null : new Money(amount, facts.currency);
  const locale = intlLocale();
  const display = (amount: typeof facts.net) =>
    formatDecimalValue(amount, locale, { currency: series.currency }).text;
  const lastDate = series.points.at(-1)?.date;
  const cutoff =
    rangeDays === null || lastDate === undefined
      ? null
      : new Date(Date.parse(`${lastDate}T12:00:00Z`) - rangeDays * 86_400_000)
          .toISOString()
          .slice(0, 10);
  const within =
    cutoff === null ? series.points : series.points.filter((point) => point.date >= cutoff);
  const points = cutoff !== null && within.length < 2 ? series.points.slice(-2) : within;
  const components = [...series.components].sort(
    (a, b) => (STACK_RANK[a.key] ?? 9) - (STACK_RANK[b.key] ?? 9),
  );
  const yearChange = (rows: typeof series.points) => {
    const end = rows.at(-1);
    if (end === undefined || rows.length < 2) return null;
    const startDate = new Date(Date.parse(`${end.date}T12:00:00Z`) - 365 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const start = rows.find((row) => row.date >= startDate) ?? rows[0];
    if (start === undefined || start === end) return null;
    const delta = end.value.sub(start.value);
    return {
      money: new Money(delta, series.currency),
      percent: start.value.isZero() ? null : delta.div(start.value.abs()),
    };
  };
  let low = points[0]?.value;
  let high = low;
  for (const point of points) {
    if (low === undefined || point.value.lt(low)) low = point.value;
    if (high === undefined || point.value.gt(high)) high = point.value;
  }
  const latest = points.at(-1)?.value;
  const setupByModule = {
    budget: budgetSetup,
    assets: assetsSetup,
    loans: loansSetup,
    investments: investmentSetup,
  };
  const pending = modules
    .filter((module) => module.enabled && module.setupState !== "ready" && module.id !== "assets")
    .map((module) => {
      const result = setupByModule[module.id as keyof typeof setupByModule];
      const steps = result?.ok ? result.value.steps : [];
      const key = `cashu.overview.hidden.${args.vault}.${module.id}.${module.setupState}`;
      return {
        id: module.id,
        state: module.setupState,
        hidden:
          hiddenKeys.has(key) ||
          (typeof localStorage !== "undefined" && localStorage.getItem(key) === "1"),
        done: steps.filter((step) => step.status === "done" && !step.optional).length,
        total: steps.filter((step) => !step.optional).length,
        next: steps.find((step) => step.status === "on")?.title ?? null,
      };
    });
  return {
    today: args.today,
    privacy,
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
    chart: points.map((point) => point.value.toFloat()),
    chartSummary:
      latest === undefined || low === undefined || high === undefined
        ? undefined
        : S.exactSeries(display(latest), display(low), display(high)),
    chartTip: (index: number): ChartTip => {
      const point = points[index];
      return point === undefined
        ? { title: S.empty, rows: [] }
        : {
            title: formatCalendarDate(point.date, locale),
            rows: [{ name: S.netWorth, value: display(point.value), amount: true }],
          };
    },
    points: points.map((point) => ({
      date: point.date,
      value: new Money(point.value, series.currency),
    })),
    chartMode,
    setChartMode,
    scope,
    setScope,
    granularity,
    setGranularity,
    rangeDays,
    setRangeDays,
    annualTotal: yearChange(annualTotal.points),
    annualLiquid: yearChange(annualLiquid.points),
    layers: components.map((component, index) => ({
      key: component.key,
      name: component.label,
      color: ((index % 8) + 1) as SeriesColor,
      values: points.map((point) => point.components[component.key]?.toFloat() ?? 0),
    })),
    stackTip: (index: number): ChartTip => {
      const point = points[index];
      return point === undefined
        ? { title: S.empty, rows: [] }
        : {
            title: formatCalendarDate(point.date, locale),
            rows: [
              ...components.flatMap((component) => {
                const amount = point.components[component.key];
                return amount === undefined || amount.isZero()
                  ? []
                  : [{ name: component.label, value: display(amount), amount: true as const }];
              }),
              { name: N.netWorthLower, value: display(point.value), amount: true },
            ],
          };
    },
    modules: modules.filter((module) => module.enabled),
    pending,
    hidePending: (id: string, state: string) => {
      if (typeof localStorage !== "undefined") {
        const key = `cashu.overview.hidden.${args.vault}.${id}.${state}`;
        localStorage.setItem(key, "1");
        setHiddenKeys((prior) => new Set([...prior, key]));
      }
    },
    budget: {
      ...budgetWidgets,
      dueThisWeek: privacy ? [] : budgetWidgets.dueThisWeek,
      dueCount: budgetWidgets.dueThisWeek.length,
    },
    loans,
    investment,
    investmentLastRunDate: investment.status === "available" ? dm(investment.lastRun?.at) : "-",
    accounts: accounts
      .filter((account) =>
        ["checking", "savings", "credit", "investment", "other"].includes(account.type),
      )
      .filter((account) => account.bank !== "manual" || account.type !== "other")
      .sort((a, b) => {
        const left = a.amount?.abs() ?? D("0");
        const right = b.amount?.abs() ?? D("0");
        return right.gt(left) ? 1 : right.lt(left) ? -1 : 0;
      })
      .map((account) => ({
        ...account,
        balance: account.amount === null ? null : new Money(account.amount, account.currency),
        empty: account.amount === null || account.amount.abs().lt(D("0.005")),
      })),
    showEmptyAccounts,
    setShowEmptyAccounts,
  };
}

export type OverviewScreenState = ReturnType<typeof useOverviewScreen>;
