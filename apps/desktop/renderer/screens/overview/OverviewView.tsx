import { DateText, Delta, LineChart, Money } from "@cashu/ui";
import { S } from "../../Desktop.strings.js";
import type { OverviewScreenState } from "./useOverviewScreen.js";

export interface OverviewViewProps {
  canOpenLegacy: boolean;
  state: OverviewScreenState;
  onCurrencyPicked(currency: string): void;
  onModuleOpened(module: string): void;
}

/** A pure first overview. Complete legacy widgets/drawers remain TRANSITIONAL(S55b). */
export function OverviewView({
  state,
  canOpenLegacy,
  onCurrencyPicked,
  onModuleOpened,
}: OverviewViewProps) {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 p-6" aria-label={S.overview}>
      <h1 className="text-headline font-strong">{S.overview}</h1>
      <p data-testid="overview-day" className="text-caption text-fg-muted">
        <DateText value={state.today} />
      </p>
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-labelledby="net-worth-title"
      >
        <h2 id="net-worth-title" className="text-title text-fg-secondary">
          {S.netWorth}
        </h2>
        <div data-testid="net-worth">
          <Money value={state.net} size="display" weight="strong" />
        </div>
        {state.change !== null && (
          <p className="mt-2 flex gap-2">
            <Delta kind="money" value={state.change} />
            <DateText value={state.since} />
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-4">
          {state.otherCurrencies.map((value) => (
            <Money key={value.currency} value={value} />
          ))}
        </div>
        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-fg-muted">{S.liquid}</dt>
            <dd>
              <Money value={state.liquid} size="title" />
            </dd>
          </div>
          <div>
            <dt className="text-fg-muted">{S.liabilities}</dt>
            <dd>
              <Money value={state.liabilities} size="title" />
            </dd>
          </div>
          {state.homeEquity !== null && (
            <div>
              <dt className="text-fg-muted">{S.homeEquity}</dt>
              <dd>
                <Money value={state.homeEquity} size="title" />
              </dd>
            </div>
          )}
        </dl>
      </section>
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-labelledby="history-title"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="history-title" className="text-title font-strong">
            {S.history}
          </h2>
          <label>
            {S.currency}{" "}
            <select
              value={state.currency}
              onChange={(event) => onCurrencyPicked(event.target.value)}
              className="rounded-sm border border-border bg-surface p-2"
            >
              {state.currencies.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
        </div>
        {state.points.length === 0 ? (
          <p className="text-fg-muted">{S.empty}</p>
        ) : (
          <>
            <LineChart
              label={S.history}
              series={[
                {
                  values: state.chart,
                  name: state.currency,
                  area: true,
                  accessibleSummary: state.chartSummary,
                },
              ]}
              tooltip={state.chartTip}
              yFormat={false}
              valueKind="amount"
            />
            <div className="mt-3 flex justify-between gap-4">
              <DateText value={state.points[0]?.date ?? null} />
              <Money value={state.points.at(-1)?.value ?? null} />
              <DateText value={state.points.at(-1)?.date ?? null} />
            </div>
          </>
        )}
      </section>
      <section aria-label={S.moduleState} className="grid gap-4 sm:grid-cols-2">
        {state.modules.map((module) => (
          <button
            key={module.id}
            type="button"
            disabled={!canOpenLegacy}
            title={canOpenLegacy ? undefined : S.legacyUnavailable}
            onClick={() => onModuleOpened(module.id)}
            className="flex items-center justify-between rounded-md border border-border bg-surface-raised p-4 text-left hover:bg-surface-sunken"
          >
            <span className="font-strong">
              {module.id === "budget"
                ? S.budget
                : module.id === "investments"
                  ? S.investments
                  : module.id === "assets"
                    ? S.assets
                    : S.loans}
            </span>
            <span className="text-caption text-fg-muted">
              {module.setupState === "ready"
                ? S.ready
                : module.setupState === "partial"
                  ? S.partial
                  : S.setup}
            </span>
          </button>
        ))}
      </section>
    </main>
  );
}
