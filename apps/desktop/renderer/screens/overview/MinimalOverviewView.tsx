import { S as I } from "@cashu/i18n/investments/v2/Overview.strings";
import { BarChart, DateText, Delta, Money } from "@cashu/ui";
import { S } from "../../Desktop.strings.js";
import { W } from "./OverviewWidgets.strings.js";
import type { MinimalOverviewState } from "./useMinimalOverview.js";

const panel = "rounded-lg border border-border bg-surface-raised p-6";
const link = "text-accent underline-offset-2 hover:underline";

/** The overview of an investments-only profile (Python `MinimalOverview`) in a narrow frame: the
 * portfolio hero, the contributions of the last six months and the steps of this month. */
export function MinimalOverviewView({ state }: { state: MinimalOverviewState }) {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-6 p-6" aria-label={S.overview}>
      <h1 className="text-headline font-strong">{S.overview}</h1>
      {state.kind === "unavailable" ? (
        <section className={panel} aria-label={I.portfolio}>
          <h2 className="text-title font-strong">{I.portfolio}</h2>
          <p className="text-fg-muted">{W.investmentUnavailable}</p>
        </section>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <section className={`${panel} md:col-span-3`} aria-label={I.portfolio}>
            <p className="text-caption text-fg-muted">{state.heroLabel}</p>
            <div data-testid="minimal-portfolio-value">
              <Money value={state.value} size="display" weight="strong" />
            </div>
            {state.pnl !== null && (
              <p className="mt-2 flex flex-wrap gap-2">
                <Delta kind="money" value={state.pnl.amount} />
                <span>
                  (<Delta kind="percent" value={state.pnl.ratio} />)
                </span>
                <span className="text-fg-muted">{I.sinceFirstDeposit}</span>
              </p>
            )}
            <dl className="mt-6 grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-fg-muted">{I.deposited}</dt>
                <dd>
                  <Money value={state.deposited} size="title" fractionDigits={0} />
                </dd>
                {state.depositedDetail !== null && (
                  <dd className="text-caption text-fg-muted">{state.depositedDetail}</dd>
                )}
              </div>
              <div title={state.benchmarkTitle ?? undefined}>
                <dt className="text-fg-muted">{W.benchmark}</dt>
                <dd>
                  {state.benchmark === null ? (
                    "-"
                  ) : (
                    <Delta kind="percent" value={state.benchmark} size="title" />
                  )}
                </dd>
                {state.benchmarkDetail !== null && (
                  <dd className="text-caption text-fg-muted">{state.benchmarkDetail}</dd>
                )}
              </div>
              <div>
                <dt className="text-fg-muted">{I.nextDeposit}</dt>
                <dd>
                  <DateText value={state.due} size="title" />
                </dd>
                {state.nextDepositDetail !== null && (
                  <dd className="text-caption text-fg-muted">{state.nextDepositDetail}</dd>
                )}
              </div>
            </dl>
            <div className="mt-4 flex flex-wrap items-center gap-3 text-caption">
              {state.holdings !== null && (
                <span className="rounded-sm border border-border px-2 py-0.5">
                  {state.holdings}
                </span>
              )}
              <span className="text-fg-muted">{state.quiet}</span>
            </div>
          </section>
          <section className={`${panel} md:col-span-2`} aria-labelledby="minimal-deposits-title">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
              <h2 id="minimal-deposits-title" className="text-title font-strong">
                {I.depositsTitle} <span className="text-caption text-fg-muted">{I.months6}</span>
              </h2>
              {state.planCaption !== null && (
                <span className="text-caption text-fg-muted">{state.planCaption}</span>
              )}
            </div>
            <BarChart
              label={I.depositsChart}
              height={150}
              values={state.chart.values}
              labels={state.chart.labels}
              kinds={state.chart.kinds}
              valueLabels={state.chart.valueLabels}
              plan={state.chart.plan}
              {...(state.chart.planLabel === undefined ? {} : { planLabel: state.chart.planLabel })}
              valueKind="amount"
            />
            {state.regularity !== null && (
              <p className="mt-3 border-t border-border pt-3 text-caption">
                {I.regularity} <strong>{state.regularity}</strong>
              </p>
            )}
          </section>
          <section className={panel} aria-labelledby="minimal-month-title">
            <h2 id="minimal-month-title" className="text-title font-strong">
              {I.thisMonth}
            </h2>
            <ol className="mt-3 grid gap-3">
              {state.previous !== null && (
                <li className="flex gap-3">
                  <span className="font-strong text-positive" role="img" aria-label={I.done}>
                    ✓
                  </span>
                  <div>
                    <p>{state.previous.label}</p>
                    <p className="text-caption text-fg-muted">{state.previous.detail}</p>
                  </div>
                </li>
              )}
              <li className="flex gap-3" aria-current={state.current.done ? undefined : "step"}>
                {state.current.done ? (
                  <span className="font-strong text-positive" role="img" aria-label={I.done}>
                    ✓
                  </span>
                ) : (
                  <span className="font-strong text-accent" role="img" aria-label={I.step2}>
                    2
                  </span>
                )}
                <div className="flex-1">
                  <p>{state.current.label}</p>
                  <p className="text-caption text-fg-muted">{state.current.detail}</p>
                </div>
                {state.current.canPlan && (
                  <button type="button" disabled={state.busy} onClick={state.onPlan}>
                    {I.plan}
                  </button>
                )}
              </li>
              <li className="flex gap-3">
                <span className="font-strong text-fg-muted" aria-hidden="true">
                  3
                </span>
                <div className="text-fg-muted">
                  <p>{I.nothingMore}</p>
                  <p className="text-caption">{I.monthlyReviewEnough}</p>
                </div>
              </li>
            </ol>
            {state.error !== null && (
              <p role="alert" className="mt-3 text-negative">
                {state.error}
              </p>
            )}
            <p className="mt-4 border-t border-border pt-3 text-caption">
              <button type="button" className={link} onClick={state.onAddAlert}>
                {I.addAlert}
              </button>{" "}
              ·{" "}
              <button type="button" className={link} onClick={state.onWatchInstrument}>
                {I.watchInstrument}
              </button>
            </p>
          </section>
        </div>
      )}
    </main>
  );
}
