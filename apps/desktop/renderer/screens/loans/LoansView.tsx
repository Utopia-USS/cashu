// The Kredyty tab (ab24ab6 modules/loans/Loans.tsx): every loan in one table, the selected one's figures,
// balance chart and repayment schedule below. Pure; the hook supplies formatted rows.
import { S } from "@cashu/i18n/loans/Loans.strings";
import {
  Button,
  dataTableCls,
  dataTdCls,
  dataThCls,
  Empty,
  Kpi,
  Kpis,
  ScrollableChart,
  SectionCard,
  scrollCls,
  Tag,
} from "@cashu/ui";
import { chartRanges, xTick } from "./loansModel.js";
import type { LoansState } from "./useLoansScreen.js";

export interface LoansViewProps {
  state: LoansState;
  /** The empty state's "Konfiguracja" (old `go({kind: "setup", module: "loans"})`). */
  onSetup(): void;
}

/** Old `tr.clickable` (pointer, chip on hover) and the selected row's chip background. */
const rowCls = (on: boolean) => `cursor-pointer hover:bg-chip ${on ? "bg-chip" : ""}`;
/** Old `button.lnk` with the inline 14px text colour, no underline, 600 when selected. */
const nameCls = (on: boolean) =>
  `cursor-pointer border-0 bg-transparent p-0 text-left text-md text-fg no-underline ${on ? "font-strong" : "font-regular"}`;

export function LoansView({ state, onSetup }: LoansViewProps) {
  if (!state.count)
    return (
      <SectionCard id="loans-empty" title={S.title}>
        <Empty title={S.none} action={<Button onPress={onSetup}>{S.setup}</Button>} />
      </SectionCard>
    );
  const detail = state.detail;
  return (
    <>
      <SectionCard id="loans-list" title={S.title} tags={<Tag>{S.nLoans(state.count)}</Tag>}>
        <div className={scrollCls()}>
          <table aria-label={S.title} className={dataTableCls}>
            <thead>
              <tr>
                <th className={dataThCls()}>{S.loan}</th>
                <th className={dataThCls(true)}>{S.installment}</th>
                <th className={dataThCls(true)}>{S.remaining}</th>
                <th className={dataThCls(true)}>{S.totalInterest}</th>
                <th className={dataThCls()}>{S.payoffBy}</th>
              </tr>
            </thead>
            <tbody>
              {state.rows.map((l, k) => {
                const on = k === state.selected;
                return (
                  <tr key={l.key} className={rowCls(on)} onClick={() => state.select(k)}>
                    <td className={dataTdCls()}>
                      <button
                        type="button"
                        className={nameCls(on)}
                        aria-pressed={on}
                        onClick={(e) => {
                          e.stopPropagation();
                          state.select(k);
                        }}
                      >
                        {l.name}
                      </button>
                    </td>
                    <td className={dataTdCls(true)}>{l.installment}</td>
                    <td className={`${dataTdCls(true)} text-negative`}>{l.remaining}</td>
                    <td className={dataTdCls(true)}>{l.totalInterest}</td>
                    <td className={dataTdCls()}>{l.payoff}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>
      {detail && (
        <>
          <Kpis>
            {detail.kpis.map((k) => (
              <Kpi key={k.label} {...k} />
            ))}
          </Kpis>
          <ScrollableChart
            title={detail.chart.title}
            label={detail.chart.title}
            ranges={chartRanges()}
            range={state.range}
            onRangeChange={state.setRange}
            labels={detail.chart.labels}
            span={detail.chart.span}
            time={{ xs: detail.chart.xs, tickFormat: xTick, minTickGap: 40 }}
            bars={[]}
            line={{ name: S.balance, values: detail.chart.values, color: "negative", dots: false }}
            yFormat={detail.chart.yFormat}
            tooltip={detail.chart.tooltip}
            summary={detail.chart.summary}
            emptyText={S.noSchedule}
          />
          <SectionCard id="loans-schedule" title={S.schedule}>
            <div className={scrollCls(true)}>
              <table aria-label={S.schedule} className={dataTableCls}>
                <thead>
                  <tr>
                    <th className={dataThCls(true)}>#</th>
                    <th className={dataThCls()}>{S.date}</th>
                    <th className={dataThCls(true)}>{S.installment}</th>
                    <th className={dataThCls(true)}>{S.interest}</th>
                    <th className={dataThCls(true)}>{S.principal}</th>
                    <th className={dataThCls(true)}>{S.balance}</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.schedule.map((s) => (
                    <tr key={s.n}>
                      <td className={dataTdCls(true)}>{s.n}</td>
                      <td className={dataTdCls()}>{s.date}</td>
                      <td className={dataTdCls(true)}>{s.payment}</td>
                      <td className={dataTdCls(true)}>{s.interest}</td>
                      <td className={dataTdCls(true)}>{s.principal}</td>
                      <td className={dataTdCls(true)}>{s.balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </>
      )}
    </>
  );
}
