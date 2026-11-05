// The Wydatki tab (ab24ab6 modules/budget/Expenses.tsx): the spending card (currency switch, period mode, period
// stepper, spending donut) and, after a category is picked, its transactions card (sort / order switches, close,
// the table with a category select per row).

import { S } from "@cashu/i18n/budget/Expenses.strings";
import { S as D } from "@cashu/i18n/budget/SpendingDonut.strings";
import { C } from "@cashu/i18n/core/common.strings";
import {
  Button,
  ChartCard,
  dataTableCls,
  dataTdCls,
  dataThCls,
  PeriodStepper,
  Seg,
  Select,
  Skeleton,
  SpendingDonut,
  scrollCls,
} from "@cashu/ui";
import { CurrencySwitch } from "./CurrencySwitch.js";
import type { Mode } from "./expensesModel.js";
import type { ExpensesState } from "./useExpensesScreen.js";

const CLOSE = "✕";

export function ExpensesView({ state }: { state: ExpensesState }) {
  const { drill } = state;
  return (
    <>
      <ChartCard
        title={S.expenses}
        controls={
          <>
            <CurrencySwitch bc={state.bc} />
            <Seg<Mode>
              items={[
                [S.month, "month"],
                [S.quarter, "quarter"],
                [S.year, "year"],
                [S.all, "all"],
              ]}
              value={state.mode}
              onChange={state.switchMode}
            />
            <PeriodStepper label={state.periodLabel} hidden={!state.canNav} onStep={state.step} />
          </>
        }
      >
        <SpendingDonut
          label={S.expenses}
          slices={state.slices}
          total={{ label: D.total, value: state.total }}
          onSelect={state.openDrill}
        />
      </ChartCard>

      {drill && (
        <ChartCard
          title={drill.title}
          controls={
            <>
              <Seg<"date" | "amount">
                label={S.sorting}
                items={[
                  [S.date, "date"],
                  [S.amount, "amount"],
                ]}
                value={drill.sort}
                onChange={state.setSort}
              />
              <Seg<"desc" | "asc">
                label={S.order}
                items={[
                  [S.desc, "desc"],
                  [S.asc, "asc"],
                ]}
                value={drill.order}
                onChange={state.setOrder}
              />
              <Button label={C.close} onPress={state.closeDrill}>
                {CLOSE}
              </Button>
            </>
          }
        >
          <div className={scrollCls()}>
            <table className={dataTableCls}>
              <thead>
                <tr>
                  <th className={dataThCls()}>{S.date}</th>
                  <th className={dataThCls()}>{S.merchant}</th>
                  <th className={dataThCls()}>{S.account}</th>
                  <th className={dataThCls(true)}>{S.amount}</th>
                  <th className={dataThCls()}>{S.category}</th>
                </tr>
              </thead>
              <tbody>
                {drill.rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className={`${dataTdCls()} text-fg-muted`}>
                      {S.noTransactions}
                    </td>
                  </tr>
                ) : (
                  drill.rows.map((r) => (
                    <tr key={r.key}>
                      <td className={dataTdCls()}>{r.date}</td>
                      <td className={dataTdCls()}>
                        {r.merchant}
                        {r.details && <div className="text-xs text-fg-muted">{r.details}</div>}
                      </td>
                      <td className={`${dataTdCls()} text-fg-muted`}>{r.account}</td>
                      <td
                        className={`${dataTdCls(true)} whitespace-nowrap ${r.negative ? "text-negative" : ""}`}
                      >
                        {r.amount}
                      </td>
                      <td className={dataTdCls()}>
                        <Select
                          label={S.category}
                          labelHidden
                          value={r.category}
                          disabled={state.busy}
                          options={state.drillOptions}
                          onChange={(category) => state.markCategory(r.key, category)}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </>
  );
}

/** First load (old `Skeleton w="100%" h={340}` inside the card). */
export function ExpensesLoadingView() {
  return (
    <ChartCard>
      <Skeleton height={340} />
    </ChartCard>
  );
}
