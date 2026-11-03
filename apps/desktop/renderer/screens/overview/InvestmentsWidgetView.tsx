import { D, Money as MoneyValue } from "@cashu/domain";
import { intlLocale } from "@cashu/i18n";
import { S as I } from "@cashu/i18n/investments/v2/Overview.strings";
import { formatCalendarDate, formatDecimalValue } from "@cashu/i18n/values";
import { LineChart, Money, Percent } from "@cashu/ui";
import { W } from "./OverviewWidgets.strings.js";
import type { InvestmentPlanState } from "./useInvestmentPlan.js";
import type { OverviewScreenState } from "./useOverviewScreen.js";

export interface InvestmentsWidgetViewProps {
  investment: OverviewScreenState["investment"];
  budget: OverviewScreenState["budget"];
  lastRunDate: string;
  plan: InvestmentPlanState;
  today: string;
  privacy: boolean;
}

/** The widget stays honest when no vault-scoped strategy/market source is bound. */
export function InvestmentsWidgetView({
  investment,
  budget,
  plan,
  today,
  privacy,
  lastRunDate,
}: InvestmentsWidgetViewProps) {
  if (investment.status !== "available")
    return (
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-label={I.investments}
      >
        <h2 className="text-title font-strong">{I.investments}</h2>
        <p className="text-fg-muted">{W.investmentUnavailable}</p>
      </section>
    );
  const currency = investment.currency;
  const value = (amount: number) =>
    formatDecimalValue(D(String(amount)), intlLocale(), { currency }).text;
  const summary =
    investment.yearPoints.length > 0
      ? formatDecimalValue(D(String(investment.yearPoints.at(-1)?.value ?? 0)), intlLocale(), {
          currency,
        }).text
      : undefined;
  const suggested = budget.month?.suggestedTransfer ?? null;
  const monthly = investment.monthPlan;
  const zeroStart = investment.value.isZero();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-labelledby="overview-investments-title"
      >
        <h2 id="overview-investments-title" className="text-title font-strong">
          {I.investments}
        </h2>
        <Money value={new MoneyValue(investment.value, currency)} size="title" />
        {!zeroStart && (
          <>
            <dl className="mt-3 grid grid-cols-3 gap-3">
              <div>
                <dt>YTD</dt>
                <dd>
                  <Percent value={investment.ytd === null ? null : D(String(investment.ytd))} />
                </dd>
                <dd className="text-caption text-fg-muted">
                  {investment.benchmarkStatus === "ok" && investment.benchmarkYtd !== null ? (
                    <Percent value={D(String(investment.benchmarkYtd))} />
                  ) : (
                    I.noBenchmark
                  )}
                </dd>
              </div>
              <div>
                <dt>{I.chancesLabel}</dt>
                <dd>{investment.positive}</dd>
              </div>
              <div>
                <dt>{I.risksLabel}</dt>
                <dd>{investment.risks}</dd>
                <dd className="text-caption text-fg-muted">
                  {investment.alertsTriggered > 0 ? I.alertsMet(investment.alertsTriggered) : null}
                </dd>
              </div>
            </dl>
            {investment.yearPoints.length > 2 && (
              <div className="mt-4">
                <LineChart
                  label={I.valueChart12m}
                  height={110}
                  yFormat={false}
                  valueKind="amount"
                  series={[
                    {
                      values: investment.yearPoints.map((point) => point.value),
                      name: currency,
                      area: true,
                      accessibleSummary: summary,
                    },
                  ]}
                  tooltip={(index) => {
                    const point = investment.yearPoints[index];
                    return point === undefined
                      ? { title: I.valueChart12m, rows: [] }
                      : {
                          title: formatCalendarDate(point.date, intlLocale()),
                          rows: [{ name: I.investments, value: value(point.value), amount: true }],
                        };
                  }}
                />
              </div>
            )}
            <p className="mt-3 text-caption text-fg-muted">
              {investment.lastRun === null ? (
                I.rulesNeverRan
              ) : (
                <>
                  {I.rules}{" "}
                  {investment.lastRun.status === "ok"
                    ? I.runOk
                    : investment.lastRun.status === "partial"
                      ? I.runPartial
                      : I.runError}{" "}
                  · {lastRunDate}
                </>
              )}
            </p>
          </>
        )}
      </section>
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-labelledby="overview-surplus-title"
      >
        <h2 id="overview-surplus-title" className="text-title font-strong">
          {zeroStart ? I.thisMonth : I.surplusTitle}
        </h2>
        {budget.month === null || suggested === null ? (
          <p className="text-fg-muted">{I.noMonthClose}</p>
        ) : (
          <div className="mt-3 grid gap-2">
            <p>
              {I.surplusOf(Number(budget.month.label.slice(5, 7)) - 1)}{" "}
              <Money value={new MoneyValue(suggested, budget.month.currency)} />
            </p>
            <p>
              {I.depositPlan}{" "}
              {monthly?.monthlyAmount === null || monthly === null ? (
                I.noPlanInStrategy
              ) : (
                <Money value={new MoneyValue(monthly.monthlyAmount, monthly.currency)} />
              )}
            </p>
            {monthly?.remaining !== null && monthly?.remaining !== undefined && (
              <p>
                {I.missing} <Money value={new MoneyValue(monthly.remaining, monthly.currency)} />
              </p>
            )}
            {monthly?.covered && <p>{I.planCovered}</p>}
          </div>
        )}
        {monthly !== null && (
          <form
            className="mt-4 flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void plan.submit();
            }}
          >
            <label className="flex flex-col gap-1">
              {I.plan}
              <input
                inputMode="decimal"
                value={plan.amount}
                onFocus={plan.start}
                onChange={(event) => plan.setAmount(event.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              />
            </label>
            <label className="flex flex-col gap-1">
              {I.nextDeposit}
              <input
                type="date"
                value={plan.date}
                min={today}
                onChange={(event) => plan.setDate(event.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              />
            </label>
            <button type="submit" disabled={plan.busy}>
              {I.plan}
            </button>
          </form>
        )}
        {plan.error !== null && (
          <p role="alert" className="text-negative">
            {plan.error}
          </p>
        )}
        {investment.openPlans.length > 0 && (
          <ul className="mt-3 text-caption">
            {investment.openPlans.map((entry) => (
              <li key={entry.gid} className="flex justify-between gap-2">
                <span>
                  {I.tagPlanned(
                    privacy
                      ? "•••"
                      : formatDecimalValue(entry.amount, intlLocale(), { currency: entry.currency })
                          .text,
                    entry.plannedDate,
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => void plan.remove(entry.gid)}
                  disabled={plan.busy}
                >
                  {W.remove}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
