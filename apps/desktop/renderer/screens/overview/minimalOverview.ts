// The investments-only overview (Python frontend `MinimalOverview`, ia-v2.md 9): a profile whose only
// enabled module is investments, once that module is past its empty state, gets the portfolio hero, the
// six-month contributions and the month's steps in a narrow frame instead of the full widget grid.
import { D, type Decimal, Money } from "@cashu/domain";
import { S as I } from "@cashu/i18n/investments/v2/Overview.strings";
import type { PortfolioSnapshot } from "@cashu/store/investments/screen";
import type { InvestmentWidgets } from "@cashu/store/overview";
import { MONTH_NOM } from "@cashu/ui-logic/core/format";
import { bananaMoney } from "@cashu/ui-logic/core/incognito";
import {
  accountLabel,
  dm,
  money,
  money0,
  nInstruments,
  pct,
} from "@cashu/ui-logic/investments/labels";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import {
  heroBenchmark,
  monthlyFlows,
  perfNotes,
  staleBenchmark,
} from "@cashu/ui-logic/investments/v2/logic";

export interface OverviewModule {
  readonly id: string;
  readonly setupState: string;
}

/** Python `Overview`: exactly one enabled module, it is investments (the only module with a minimal
 * view) and its setup is not empty. `modules` are the enabled modules. */
export function investmentsOnlyOverview(modules: readonly OverviewModule[]): boolean {
  const only = modules.length === 1 ? modules[0] : undefined;
  return only?.id === "investments" && only.setupState !== "empty";
}

type ReadyPortfolio = Extract<PortfolioSnapshot, { status: "ready" }>;
type Point = { readonly date: string; readonly flow: number | null };

/** Python `depositFacts`: positive flows, months since the first one (the current month counts once its
 * deposit is in), months with a deposit, the single repeated amount and the last deposit. */
export function depositFacts(points: readonly Point[], today: string) {
  const flows = points.flatMap((point) =>
    point.flow !== null && point.flow > 0
      ? [{ date: point.date, amount: D(String(point.flow)) }]
      : [],
  );
  const first = flows[0]?.date ?? null;
  const thisMonth = flows.some((flow) => flow.date.slice(0, 7) === today.slice(0, 7));
  const monthsSince =
    first === null
      ? 0
      : (Number(today.slice(0, 4)) - Number(first.slice(0, 4))) * 12 +
        Number(today.slice(5, 7)) -
        Number(first.slice(5, 7)) +
        (thisMonth ? 1 : 0);
  const withDeposit = new Set(flows.map((flow) => flow.date.slice(0, 7))).size;
  const amounts = new Set(flows.map((flow) => flow.amount.toString()));
  return {
    flows,
    monthsSince,
    withDeposit,
    same: amounts.size === 1 ? (flows[0]?.amount ?? null) : null,
    last: flows.at(-1) ?? null,
  };
}

interface MinimalStep {
  readonly label: string;
  readonly detail: string;
}

interface MinimalCurrentStep extends MinimalStep {
  /** Deposited this month or planned: the step shows a check instead of its number. */
  readonly done: boolean;
  /** Deposited this month (the check's label is `zrobione`, else `krok 2`). */
  readonly deposited: boolean;
  readonly canPlan: boolean;
}

export interface MinimalOverviewModel {
  readonly heroLabel: string;
  /** The hero's figures as the old view printed them (ui-logic labels, masked in privacy mode). */
  readonly text: {
    readonly value: string;
    readonly pnl: { readonly text: string; readonly tone: "positive" | "negative" } | null;
    readonly deposited: string;
    readonly benchmark: string;
    readonly due: string;
  };
  readonly value: Money;
  readonly pnl: { readonly amount: Money; readonly ratio: Decimal } | null;
  readonly deposited: Money | null;
  readonly depositedDetail: string | null;
  readonly benchmark: Decimal | null;
  readonly benchmarkDetail: string | null;
  readonly benchmarkTitle: string | null;
  readonly due: string;
  readonly nextDepositDetail: string | null;
  readonly holdings: string | null;
  readonly quiet: string;
  readonly chart: {
    readonly values: number[];
    readonly labels: string[];
    readonly kinds: ("main" | "plan")[];
    readonly valueLabels: (string | null)[];
    readonly plan: number | null;
    readonly planLabel: string | undefined;
  };
  readonly planCaption: string | null;
  readonly regularity: string | null;
  readonly previous: MinimalStep | null;
  readonly current: MinimalCurrentStep;
  /** The one-click plan of the current step: amount, date, currency and the only account. */
  readonly plan: {
    readonly amount: Decimal;
    readonly date: string;
    readonly currency: string;
    readonly account: string | null;
  } | null;
}

const HIDDEN = "•••";

/** Every figure the minimal view shows, from the portfolio over the whole history (`range: "max"`) and
 * this month's open or booked planned deposit. Money in catalog sentences is whole units, masked in privacy. */
export function minimalOverviewModel(input: {
  readonly portfolio: ReadyPortfolio;
  readonly investment: InvestmentWidgets;
  readonly today: string;
  readonly privacy: boolean;
}): MinimalOverviewModel {
  const { portfolio, today, privacy } = input;
  const currency = portfolio.overview.base_currency;
  // Python `money0`: whole units, always grouped ("2 000 zł", the locale default leaves four digits ungrouped)
  const whole = (amount: Decimal) =>
    privacy
      ? (bananaMoney(amount.toFloat(), currency) ?? HIDDEN)
      : money0(amount.toFloat(), currency);
  const kpis = portfolio.overview.kpis;
  const perf = portfolio.performance;
  const summary = perf.summary;
  const curMonth = today.slice(0, 7);
  const dep = depositFacts(perf.points, today);
  const bench = heroBenchmark(perf.benchmark, summary?.net_contributions);
  const contrib = portfolio.contributionPlan;
  const planAmount = contrib?.monthlyAmount ?? dep.same ?? dep.last?.amount ?? null;
  const day =
    contrib?.dayOfMonth ?? (dep.last === null ? null : Number(dep.last.date.slice(8, 10)));
  const due = nextDeposit(today, day);
  const accounts = portfolio.overview.accounts;
  const only = accounts.length === 1 ? accounts[0] : undefined;
  // One account has no twin, so its label is the broker and wrapper alone.
  const account =
    only === undefined
      ? null
      : accountLabel({
          id: 0,
          name: only.name,
          broker: only.broker,
          broker_name: only.broker_name,
          wrapper: only.wrapper,
        });
  const holdings = portfolio.positions.positions;
  const months = monthlyFlows(
    perf.points.map((point) => ({ date: point.date, flow: point.flow })),
    today,
    6,
  );
  const doneThisMonth = dep.flows.some((flow) => flow.date.slice(0, 7) === curMonth);
  const lastPrev = dep.flows.findLast((flow) => flow.date.slice(0, 7) < curMonth) ?? null;
  // Old `planForMonth` over the listed plans (creation order): this month's newest open plan, else its newest
  // booked one.
  const inMonth =
    input.investment.status === "available"
      ? input.investment.plans.filter((row) => row.plannedDate.slice(0, 7) === curMonth)
      : [];
  const plan =
    inMonth.findLast((row) => row.status === "planned") ??
    inMonth.findLast((row) => row.status === "booked") ??
    null;
  const polarity = kpis.polarity;
  const signals = polarity.positive + polarity.negative + polarity.neutral;
  const alertsLive = kpis.alerts.active + kpis.alerts.triggered + kpis.alerts.snoozed;
  const plannedText = planAmount === null ? null : whole(planAmount);
  const pnl =
    summary?.pnl == null || !summary.net_contributions
      ? null
      : {
          amount: new Money(D(String(summary.pnl)), currency),
          ratio: D(String(summary.pnl)).div(D(String(summary.net_contributions))),
        };
  const notes = perfNotes({
    data_quality: perf.data_quality === null ? null : { notes: [...perf.data_quality.notes] },
    benchmark: perf.benchmark,
  });
  const currentDetail = doneThisMonth
    ? I.doneThisMonth
    : plan?.status === "booked"
      ? I.bookedFromImport
      : plan !== null
        ? `${I.plannedOn(dm(plan.plannedDate))}${
            planAmount === null || !plan.amount.eq(planAmount)
              ? ` · ${privacy ? (bananaMoney(plan.amount.toFloat(), plan.currency) ?? HIDDEN) : money0(plan.amount.toFloat(), plan.currency)}`
              : ""
          }`
        : (account ?? I.perPlan);
  const pnlNum = summary?.pnl ?? null;
  const net = summary?.net_contributions ?? null;
  return {
    heroLabel: `${I.portfolio} · ${MONTH_NOM[Number(today.slice(5, 7)) - 1] ?? ""}`,
    text: {
      value: money(kpis.value.total.toFloat(), currency),
      pnl:
        pnlNum == null || !net
          ? null
          : {
              text: `${money(pnlNum, currency, true)} (${pct(pnlNum / net, true)})`,
              tone: pnlNum >= 0 ? "positive" : "negative",
            },
      deposited: net != null ? money0(net, currency) : "-",
      benchmark: bench ? pct(bench.value, true) : "-",
      due: dm(due),
    },
    value: new Money(kpis.value.total, currency),
    pnl,
    deposited:
      summary?.net_contributions == null
        ? null
        : new Money(D(String(summary.net_contributions)), currency),
    depositedDetail:
      dep.flows.length === 0
        ? null
        : dep.same !== null
          ? I.depositsOf(dep.flows.length, whole(dep.same))
          : I.deposits(dep.flows.length),
    benchmark: bench === null ? null : D(String(bench.value)),
    benchmarkDetail:
      bench?.label ??
      staleBenchmark(perf.benchmark)?.label ??
      (perf.benchmark.status === "ok" ? null : I.setInStrategy),
    benchmarkTitle: notes.length === 0 ? null : notes.join("\n"),
    due,
    nextDepositDetail: [plannedText, account].filter(Boolean).join(" · ") || null,
    holdings:
      holdings.length === 0
        ? null
        : `${nInstruments(holdings.length)}${
            holdings.length === 1
              ? ` · ${holdings[0]?.instrument.symbol ?? holdings[0]?.instrument.label ?? ""}`
              : ""
          }`,
    quiet: [
      alertsLive ? I.alerts(alertsLive) : I.noAlerts,
      signals ? I.signals(signals) : I.noSignals,
    ].join(" · "),
    chart: {
      values: months.map((month) => month.value),
      labels: months.map((month) => month.label),
      kinds: months.map((month, index) =>
        index === months.length - 1 && !month.value && planAmount !== null ? "plan" : "main",
      ),
      valueLabels: months.map((month) => (month.value ? whole(D(String(month.value))) : null)),
      plan: planAmount?.toFloat() ?? null,
      planLabel: plannedText === null ? undefined : I.planOf(plannedText),
    },
    planCaption:
      plannedText === null ? null : `${I.planOf(plannedText)}${day ? I.byDayShort(day) : ""}`,
    regularity: dep.monthsSince > 0 ? I.xOfY(dep.withDeposit, dep.monthsSince) : null,
    previous:
      lastPrev === null
        ? null
        : {
            label: I.monthDeposit(Number(lastPrev.date.slice(5, 7)) - 1),
            detail: `${whole(lastPrev.amount)} · ${dm(lastPrev.date)}`,
          },
    current: {
      done: doneThisMonth || plan !== null,
      deposited: doneThisMonth,
      label: I.depositBy(plannedText ?? "", dm(due)),
      detail: currentDetail,
      canPlan: !doneThisMonth && plan === null && planAmount !== null,
    },
    plan:
      planAmount === null
        ? null
        : { amount: planAmount, date: due, currency, account: only?.id ?? null },
  };
}
