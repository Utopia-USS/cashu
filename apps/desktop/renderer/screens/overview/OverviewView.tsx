import { D, type Decimal, Money as MoneyValue } from "@cashu/domain";
import { S as C } from "@cashu/i18n/core/overview/CoreWidgets.strings";
import { S as N } from "@cashu/i18n/core/overview/NetWorthWidget.strings";
import { S as L } from "@cashu/i18n/loans/index.strings";
import { AreaChart, DateText, Delta, LineChart, Money, Percent } from "@cashu/ui";
import { S } from "../../Desktop.strings.js";
import { AssetsWidgetView } from "./AssetsWidgetView.js";
import { CashDrawerView } from "./CashDrawerView.js";
import { InvestmentsWidgetView } from "./InvestmentsWidgetView.js";
import { W } from "./OverviewWidgets.strings.js";
import type { AssetDrawerState } from "./useAssetDrawer.js";
import type { CashDrawerState } from "./useCashDrawer.js";
import type { InvestmentPlanState } from "./useInvestmentPlan.js";
import type { OverviewScreenState } from "./useOverviewScreen.js";

const chartGroup = "flex gap-1 rounded-sm border border-border bg-surface-sunken p-0.5";
const chartChoice =
  "rounded-sm px-2 py-1 text-fg-muted hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:bg-accent-muted aria-pressed:font-strong aria-pressed:text-accent";

export interface OverviewViewProps {
  cash: CashDrawerState;
  assets: AssetDrawerState;
  investmentPlan: InvestmentPlanState;
  state: OverviewScreenState;
  onCurrencyPicked(currency: string): void;
  onModuleOpened(module: string): void;
}

/** The overview tab as a pure View. An investments-only profile gets `MinimalOverviewView` instead
 * (the route decides with `investmentsOnlyOverview`). */
export function OverviewView({
  state,
  cash,
  assets,
  investmentPlan,
  onCurrencyPicked,
  onModuleOpened,
}: OverviewViewProps) {
  const month = state.budget.month;
  const barWidth = (amount: Decimal) =>
    month === null || month.income.isZero()
      ? "0%"
      : `${Math.min(100, Math.max(0, amount.abs().div(month.income.abs()).mul(D("100")).toFloat()))}%`;
  const loanPayments = new Map<string, Decimal>();
  for (const loan of state.loans)
    loanPayments.set(
      loan.currency,
      (loanPayments.get(loan.currency) ?? D("0")).add(loan.monthlyPayment),
    );
  const showBudget = state.modules.some(
    (module) => module.id === "budget" && module.setupState !== "empty",
  );
  const showLoans = state.modules.some(
    (module) => module.id === "loans" && module.setupState !== "empty",
  );
  const showInvestments = state.modules.some(
    (module) => module.id === "investments" && module.setupState !== "empty",
  );
  const moduleLabel = (id: string) =>
    id === "budget"
      ? S.budget
      : id === "assets"
        ? S.assets
        : id === "loans"
          ? S.loans
          : S.investments;
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
        <div className="mb-4 flex flex-wrap gap-3 text-caption">
          <fieldset className={chartGroup}>
            <legend>{N.chartKind}</legend>
            <button
              type="button"
              className={chartChoice}
              aria-pressed={state.chartMode === "line"}
              onClick={() => state.setChartMode("line")}
            >
              {N.line}
            </button>
            <button
              type="button"
              className={chartChoice}
              aria-pressed={state.chartMode === "stacked"}
              onClick={() => state.setChartMode("stacked")}
            >
              {N.stacked}
            </button>
          </fieldset>
          <fieldset className={chartGroup}>
            <legend>{N.scope}</legend>
            <button
              type="button"
              className={chartChoice}
              aria-pressed={state.scope === "total"}
              onClick={() => state.setScope("total")}
            >
              {N.scopeTotal}
            </button>
            <button
              type="button"
              className={chartChoice}
              aria-pressed={state.scope === "liquid"}
              onClick={() => state.setScope("liquid")}
            >
              {N.scopeLiquid}
            </button>
          </fieldset>
          <fieldset className={chartGroup}>
            <legend>{N.range}</legend>
            {([31, 92, 183, 366, null] as const).map((days) => (
              <button
                type="button"
                className={chartChoice}
                key={days ?? "all"}
                aria-pressed={state.rangeDays === days}
                onClick={() => state.setRangeDays(days)}
              >
                {days === null
                  ? "Max"
                  : days === 366
                    ? N.year
                    : days === 31
                      ? "1M"
                      : days === 92
                        ? "3M"
                        : "6M"}
              </button>
            ))}
          </fieldset>
          <fieldset className={chartGroup}>
            <legend>{N.step}</legend>
            {(["monthly", "weekly", "daily"] as const).map((step) => (
              <button
                type="button"
                className={chartChoice}
                key={step}
                aria-pressed={state.granularity === step}
                onClick={() => state.setGranularity(step)}
              >
                {N[step]}
              </button>
            ))}
          </fieldset>
        </div>
        {state.points.length === 0 ? (
          <p className="text-fg-muted">{S.empty}</p>
        ) : (
          <>
            {state.chartMode === "stacked" && state.layers.length > 0 ? (
              <AreaChart
                label={N.stackedLabel(state.currency)}
                layers={state.layers}
                totals={state.chart}
                tooltip={state.stackTip}
                valueKind="amount"
                accessibleSummary={state.chartSummary}
              />
            ) : (
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
            )}
            <div className="mt-3 flex justify-between gap-4">
              <DateText value={state.points[0]?.date ?? null} />
              <Money value={state.points.at(-1)?.value ?? null} />
              <DateText value={state.points.at(-1)?.date ?? null} />
            </div>
            {state.chartMode === "stacked" && (
              <ul className="mt-2 flex flex-wrap gap-3 text-caption" aria-label={N.stacked}>
                {state.layers.map((layer) => (
                  <li key={layer.key}>{layer.name}</li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap justify-between gap-4 text-caption">
              <span>
                {N.months12}
                <Delta kind="money" value={state.annualTotal?.money ?? null} />{" "}
                <Percent value={state.annualTotal?.percent ?? null} />
              </span>
              <span>
                {N.noProperty}
                <Delta kind="money" value={state.annualLiquid?.money ?? null} />{" "}
                <Percent value={state.annualLiquid?.percent ?? null} />
              </span>
            </div>
          </>
        )}
      </section>
      {showBudget && (
        <div className="grid gap-4 md:grid-cols-2">
          <section
            className="rounded-lg border border-border bg-surface-raised p-6"
            aria-labelledby="overview-budget-month-title"
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 id="overview-budget-month-title" className="text-title font-strong">
                {C.budget(month?.label ?? "")}
              </h2>
              {month?.complete !== null && month?.complete !== undefined && (
                <span className="text-caption text-fg-muted">
                  {month.complete ? C.closed : C.inProgress}
                </span>
              )}
            </div>
            {month === null ? (
              <p className="text-fg-muted">{C.noLastMonth}</p>
            ) : (
              <>
                <dl className="grid gap-2">
                  {(
                    [
                      [C.income, month.income],
                      [C.expenses, month.spending],
                      [C.surplus, month.surplus],
                    ] as const
                  ).map(([label, amount]) => (
                    <div key={label} className="flex items-center gap-2">
                      <dt className="basis-24 shrink-0">{label}</dt>
                      <dd className="h-2 flex-1 rounded-sm bg-surface-sunken" aria-hidden="true">
                        <span
                          className="block h-2 rounded-sm bg-chart-1"
                          style={{ width: barWidth(amount) }}
                        />
                      </dd>
                      <dd>
                        <Money value={new MoneyValue(amount, month.currency)} />
                      </dd>
                    </div>
                  ))}
                </dl>
                <div className="mt-3 flex flex-wrap gap-3 text-caption">
                  {!month.income.isZero() && (
                    <span>
                      {C.savingsRate}
                      <Percent value={month.surplus.div(month.income)} />
                    </span>
                  )}
                  {state.budget.averageSavingsRate !== null && (
                    <span title={C.normTitle(state.budget.norm?.months ?? 6)}>
                      {C.avg6}
                      <Percent value={state.budget.averageSavingsRate} />
                    </span>
                  )}
                  {month.otherCurrencies.length > 0 && (
                    <span>{C.otherCurrencies(month.otherCurrencies.join(", "))}</span>
                  )}
                </div>
              </>
            )}
          </section>
          <section
            className="rounded-lg border border-border bg-surface-raised p-6"
            aria-labelledby="overview-subscriptions-title"
          >
            <h2 id="overview-subscriptions-title" className="text-title font-strong">
              {C.subscriptions}{" "}
              {state.budget.subscriptions.count > 0 && `(${state.budget.subscriptions.count})`}
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-3">
              <div>
                <dt>{C.monthly}</dt>
                <dd>
                  <Money
                    value={
                      new MoneyValue(
                        state.budget.subscriptions.monthlyTotals[
                          state.budget.subscriptionCurrency
                        ] ?? state.budget.subscriptions.monthlyTotal,
                        state.budget.subscriptionCurrency,
                      )
                    }
                  />
                </dd>
                {state.budget.subscriptionNorm !== null &&
                  !state.budget.subscriptionNorm.expense.isZero() && (
                    <dd className="text-caption text-fg-muted">
                      <Percent
                        value={(
                          state.budget.subscriptions.monthlyTotals[
                            state.budget.subscriptionCurrency
                          ] ?? state.budget.subscriptions.monthlyTotal
                        ).div(state.budget.subscriptionNorm.expense)}
                      />{" "}
                      {W.ofMonthlySpending}
                    </dd>
                  )}
              </div>
              <div>
                <dt>{C.thisWeek}</dt>
                <dd>{state.budget.dueCount}</dd>
                <dd className="text-caption text-fg-muted">
                  {state.privacy
                    ? state.budget.dueThisWeek.length > 0
                      ? "•••"
                      : ""
                    : state.budget.dueThisWeek.slice(0, 3).join(", ")}
                </dd>
              </div>
            </dl>
            {state.budget.staleCount > 0 && (
              <p className="mt-3 text-caption text-warning">
                {C.noCharge(state.budget.staleCount)}
              </p>
            )}
          </section>
        </div>
      )}
      {state.pending
        .filter((module) => module.state === "partial" && !module.hidden)
        .map((module) => (
          <div
            key={`partial:${module.id}`}
            role="status"
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-surface-raised p-3"
          >
            <span>
              <strong>{moduleLabel(module.id)}</strong> · {W.stepsDone(module.done, module.total)}
            </span>
            <span className="flex gap-2">
              <button type="button" onClick={() => onModuleOpened(module.id)}>
                {W.continueSetup}
              </button>
              <button type="button" onClick={() => state.hidePending(module.id, module.state)}>
                {W.hide}
              </button>
            </span>
          </div>
        ))}
      <section aria-label={S.moduleState} className="grid gap-4 sm:grid-cols-2">
        {state.pending
          .filter((module) => !module.hidden)
          .map((module) => (
            <div
              key={`pending:${module.id}`}
              className="rounded-md border border-dashed border-border bg-surface-raised p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <h2 className="font-strong">{moduleLabel(module.id)}</h2>
                <button type="button" onClick={() => state.hidePending(module.id, module.state)}>
                  {W.hide}
                </button>
              </div>
              <p className="mt-2 text-caption text-fg-muted">
                {module.next === null ? W.waitsForData : W.nextStep(module.next)}
              </p>
              <div className="mt-3 flex items-center justify-between gap-3">
                <span>{W.stepsDone(module.done, module.total)}</span>
                <button type="button" onClick={() => onModuleOpened(module.id)}>
                  {W.continueSetup}
                </button>
              </div>
            </div>
          ))}
        {state.modules
          .filter((module) => module.setupState === "ready")
          .map((module) => (
            <button
              key={module.id}
              type="button"
              onClick={() => onModuleOpened(module.id)}
              className="flex items-center justify-between rounded-md border border-border bg-surface-raised p-4 text-left hover:bg-surface-sunken"
            >
              <span className="font-strong">{moduleLabel(module.id)}</span>
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
      <section
        className="rounded-lg border border-border bg-surface-raised p-6"
        aria-labelledby="overview-accounts-title"
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 id="overview-accounts-title" className="text-title font-strong">
            {W.accounts} {state.accounts.length > 0 && <span>({state.accounts.length})</span>}
          </h2>
          {state.accounts.some((account) => account.empty) && (
            <button
              type="button"
              onClick={() => state.setShowEmptyAccounts(!state.showEmptyAccounts)}
            >
              {state.showEmptyAccounts
                ? W.hideEmpty
                : W.showEmpty(state.accounts.filter((account) => account.empty).length)}
            </button>
          )}
        </div>
        {state.accounts.length === 0 ? (
          <p className="text-fg-muted">{W.noAccounts}</p>
        ) : (
          <ul className="divide-y divide-border">
            {state.accounts
              .filter((account) => state.showEmptyAccounts || !account.empty)
              .map((account) => (
                <li key={account.gid} className="flex items-center justify-between gap-3 py-3">
                  <div>
                    <p className="font-strong">{state.privacy ? "•••" : account.name}</p>
                    <p className="text-caption text-fg-muted">
                      {state.privacy ? "•••" : `${account.bank} ${account.ibanTail ?? ""}`}
                    </p>
                  </div>
                  <Money value={account.balance} />
                </li>
              ))}
          </ul>
        )}
        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
          <span>
            {W.cash}: <Money value={new MoneyValue(cash.wallet.balance, cash.wallet.currency)} />
          </span>
          <button type="button" onClick={() => cash.setOpen(true)} className="text-accent">
            {cash.wallet.exists ? W.addCashExpense : W.cash}
          </button>
        </div>
      </section>
      {state.modules.some((module) => module.id === "assets") && (
        <AssetsWidgetView
          state={assets}
          today={state.today}
          baseCurrency={state.net?.currency ?? state.currency}
          privacy={state.privacy}
        />
      )}
      {showLoans && (
        <section
          className="rounded-lg border border-border bg-surface-raised p-6"
          aria-labelledby="overview-loans-title"
        >
          <h2 id="overview-loans-title" className="text-title font-strong">
            {L.title} {state.loans.length > 0 && `(${state.loans.length})`}
          </h2>
          {state.loans.length === 0 ? (
            <p className="mt-3 text-fg-muted">{L.none}</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {state.loans.map((loan) => (
                <li key={loan.gid} className="flex justify-between gap-3 py-3">
                  <div>
                    <p className="font-strong">{state.privacy ? "•••" : loan.name}</p>
                    <p className="text-caption text-fg-muted">
                      {L.installment("")}
                      <Money value={new MoneyValue(loan.monthlyPayment, loan.currency)} /> ·{" "}
                      <Percent value={loan.annualRate.div(D("100"))} /> ·{" "}
                      {L.until(loan.payoffDate.slice(0, 4))}
                    </p>
                  </div>
                  <div className="text-right">
                    <Money value={new MoneyValue(loan.outstanding.neg(), loan.currency)} />
                    {loan.nextPrincipal !== null && (
                      <p className="text-caption text-fg-muted">
                        <Money value={new MoneyValue(loan.nextPrincipal.neg(), loan.currency)} />
                        {L.perMonth}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {loanPayments.size > 0 && (
            <div className="mt-3 flex flex-wrap gap-3 border-t border-border pt-3 text-caption">
              {L.installments}{" "}
              {[...loanPayments].map(([currency, amount]) => (
                <Money key={currency} value={new MoneyValue(amount, currency)} />
              ))}
              {state.budget.norm !== null &&
                !state.budget.norm.income.isZero() &&
                loanPayments.has(state.net?.currency ?? state.currency) && (
                  <span title={C.normTitle(state.budget.norm.months)}>
                    <Percent
                      value={(
                        loanPayments.get(state.net?.currency ?? state.currency) ?? D("0")
                      ).div(state.budget.norm.income)}
                    />{" "}
                    {W.ofMonthlyIncome}
                  </span>
                )}
            </div>
          )}
        </section>
      )}
      {showInvestments && (
        <InvestmentsWidgetView
          investment={state.investment}
          budget={state.budget}
          lastRunDate={state.investmentLastRunDate}
          plan={investmentPlan}
          today={state.today}
          privacy={state.privacy}
        />
      )}
      <CashDrawerView state={cash} privacy={state.privacy} />
    </main>
  );
}
