import { Money as MoneyValue } from "@cashu/domain";
import { S as F } from "@cashu/i18n/loans/Drawers.strings";
import { S } from "@cashu/i18n/loans/Loans.strings";
import { Button, DateText, LineChart, Money, useVirtualRows } from "@cashu/ui";
import { useRef } from "react";
import { L } from "./Loans.strings.js";
import type { LoansState } from "./useLoansScreen.js";

export interface LoansViewProps {
  state: LoansState;
}

/** Loan balances and interest remain exact; chart geometry is supplied by the hook. */
export function LoansView({ state }: LoansViewProps) {
  const loan = state.current;
  return (
    <main className="grid gap-6 p-6" data-testid="native-loans">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-headline font-strong">{L.title}</h1>
        <div className="flex gap-3">
          <Button disabled={state.privacy || state.busy} onPress={state.openLoan}>
            {L.add}
          </Button>
          {state.budgetOn && (
            <Button
              disabled={loan === null || state.privacy || state.busy}
              onPress={state.openPayment}
            >
              {L.payments}
            </Button>
          )}
        </div>
      </header>
      {state.notice && <p role="status">{state.notice}</p>}
      {loan === null ? (
        <p>{L.empty}</p>
      ) : (
        <>
          <LoanListView state={state} />
          <label className="flex flex-col gap-1">
            {L.choose}
            <select
              value={state.selected ?? ""}
              onChange={(e) => state.setSelected(e.target.value)}
              className="rounded-sm border border-border bg-surface p-2"
            >
              {state.rows.map((row, i) => (
                <option key={row.id} value={row.id}>
                  {state.privacy ? `${L.hidden} ${i + 1}` : (row.name ?? S.loan)}
                </option>
              ))}
            </select>
          </label>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              [S.monthlyInstallment, loan.monthlyPayment],
              [S.remaining, loan.outstanding],
              [S.totalInterest, loan.totalInterest],
              [S.paidInterest, loan.paidInterest],
            ].map(([label, value]) => (
              <section
                key={String(label)}
                className="rounded-lg border border-border bg-surface-raised p-4"
              >
                <h2 className="text-caption text-fg-muted">{String(label)}</h2>
                <Money value={new MoneyValue(value as typeof loan.outstanding, loan.currency)} />
              </section>
            ))}
            <section className="rounded-lg border border-border bg-surface-raised p-4">
              <h2 className="text-caption text-fg-muted">{S.payoffDate}</h2>
              <DateText value={loan.payoffDate} />
              <p className="text-caption text-fg-muted">{S.paidCount(loan.monthsElapsed)}</p>
            </section>
          </div>
          <section className="rounded-lg border border-border bg-surface-raised p-4">
            <h2>{S.balanceOf(state.privacy ? L.hidden : (loan.name ?? S.loan))}</h2>
            <fieldset
              aria-label={L.chartRange}
              className="my-3 flex flex-wrap gap-1 rounded-sm border border-border bg-surface-sunken p-0.5"
            >
              {[365, 1825, 3650, null].map((days) => (
                <Button
                  key={days ?? "all"}
                  pressed={state.range === days}
                  onPress={() => state.setRange(days)}
                >
                  {days === null
                    ? L.max
                    : days === 365
                      ? S.oneYear
                      : S.years(days === 1825 ? 5 : 10)}
                </Button>
              ))}
            </fieldset>
            <LineChart
              label={S.balance}
              series={[
                {
                  values: state.points.map((p) => p.balance.toFloat()),
                  accessibleSummary: state.chartSummary,
                  tone: "negative",
                  name: S.balance,
                },
              ]}
              xLabels={state.chartLabels}
              valueKind="amount"
              yFormat={false}
              tooltip={state.chartTip}
            />
          </section>
          <ScheduleView key={loan.id} state={state} />
          <p className="text-caption text-fg-muted">{F.variableRate}</p>
        </>
      )}
    </main>
  );
}

/** Fixed-height virtual rows keep long mortgage schedules bounded in the DOM. */
function ScheduleView({ state }: LoansViewProps) {
  const parent = useRef<HTMLDivElement>(null);
  const rows = state.current?.summary.schedule ?? [];
  const virtual = useVirtualRows({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const money = (value: (typeof rows)[number]["payment"]) =>
    new MoneyValue(value, state.current?.currency ?? "PLN");
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <h2>{S.schedule}</h2>
      <div ref={parent} className="max-h-96 overflow-auto">
        <table aria-label={S.schedule} aria-rowcount={rows.length + 1} className="grid w-full">
          <thead className="sticky top-0 z-10 bg-surface-raised">
            <tr className="grid grid-cols-6 gap-2 border-b border-border py-3 text-caption">
              {["#", S.date, S.installment, S.interest, S.principal, S.balance].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="relative block" style={{ height: virtual.totalSize }}>
            {virtual.items.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <tr
                  key={item.key}
                  aria-rowindex={item.index + 2}
                  className="absolute left-0 top-0 grid h-12 w-full grid-cols-6 items-center gap-2 border-b border-border text-caption"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <td>{row.n}</td>
                  <td>
                    <DateText value={row.date} />
                  </td>
                  <td>
                    <Money value={money(row.payment)} />
                  </td>
                  <td>
                    <Money value={money(row.interest)} />
                  </td>
                  <td>
                    <Money value={money(row.principal)} />
                  </td>
                  <td>
                    <Money value={money(row.balance)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Comparable loan rows, virtualized when a vault has many liabilities. */
function LoanListView({ state }: LoansViewProps) {
  const parent = useRef<HTMLDivElement>(null);
  const virtual = useVirtualRows({
    count: state.rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 48,
    overscan: 5,
  });
  const large = state.rows.length > 50;
  const items = large
    ? virtual.items.map((item) => ({ index: item.index, start: item.start }))
    : state.rows.map((_, index) => ({ index, start: 0 }));
  return (
    <section className="rounded-lg border border-border bg-surface-raised p-4">
      <div ref={parent} className="max-h-72 overflow-auto">
        <table aria-label={L.title} aria-rowcount={state.rows.length + 1} className="grid w-full">
          <thead className="sticky top-0 z-10 bg-surface-raised">
            <tr className="grid grid-cols-5 gap-2 py-3 text-caption">
              {[S.loan, S.installment, S.remaining, S.totalInterest, S.payoffBy].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody
            className="relative block"
            style={large ? { height: virtual.totalSize } : undefined}
          >
            {items.map((item) => {
              const row = state.rows[item.index];
              if (!row) return null;
              return (
                <tr
                  key={row.id}
                  aria-rowindex={item.index + 2}
                  className={`${large ? "absolute left-0 top-0 " : ""}grid h-12 w-full grid-cols-5 items-center gap-2 border-t border-border text-caption ${state.selected === row.id ? "bg-accent-muted" : ""}`}
                  style={large ? { transform: `translateY(${item.start}px)` } : undefined}
                >
                  <td>
                    <button
                      type="button"
                      className="rounded-sm px-2 py-1 text-left hover:bg-surface-sunken focus-visible:outline-2 focus-visible:outline-accent aria-pressed:font-strong aria-pressed:text-accent"
                      aria-pressed={state.selected === row.id}
                      onClick={() => state.setSelected(row.id)}
                    >
                      {state.privacy ? `${L.hidden} ${item.index + 1}` : (row.name ?? S.loan)}
                    </button>
                  </td>
                  <td>
                    <Money value={new MoneyValue(row.monthlyPayment, row.currency)} />
                  </td>
                  <td>
                    <Money value={new MoneyValue(row.outstanding.neg(), row.currency)} />
                  </td>
                  <td>
                    <Money value={new MoneyValue(row.totalInterest, row.currency)} />
                  </td>
                  <td>
                    <DateText value={row.payoffDate} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
