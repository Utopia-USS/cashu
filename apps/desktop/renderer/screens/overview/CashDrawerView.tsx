// Gotówka w portfelu (ab24ab6 core/overview/CoreWidgets.tsx AccountsWidget drawer + components/CashCard.tsx): the
// cash balance with withdrawn / spent, the quick add row (amount, title, category) and the cash transactions.
// Pure: the strings come formatted from useCashDrawer; the hook owns every command.

import { C } from "@cashu/i18n/core/common.strings";
import { S as K } from "@cashu/i18n/core/components/CashCard.strings";
import { S as CW } from "@cashu/i18n/core/overview/CoreWidgets.strings";
import {
  Button,
  Drawer,
  dataTableCls,
  dataTdCls,
  dataThCls,
  Notice,
  Select,
  scrollCls,
  TextField,
} from "@cashu/ui";
import type { CashDrawerState } from "./useCashDrawer.js";

export interface CashDrawerViewProps {
  state: CashDrawerState;
}

const DOWN = "⬇︎ ";
const REMOVE = "✕";

export function CashDrawerView({ state }: CashDrawerViewProps) {
  if (!state.open) return null;
  const d = state.display;
  return (
    <Drawer
      width={560}
      title={CW.walletTitle}
      label={CW.walletTitle}
      onClose={() => state.setOpen(false)}
    >
      <section className="rounded-widget border border-border bg-surface-raised px-4.5 py-4">
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <strong className="text-md" title={K.cashHint}>
            {K.cash}
          </strong>
          <span className={`text-base font-heavy ${d.negative ? "text-negative" : ""}`}>
            {d.balance}
          </span>
          <span className="flex-1" />
          <span className="text-xs text-fg-muted">{d.withdrawnSpent}</span>
        </div>
        <form
          className="mb-3.5 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void state.submit();
          }}
        >
          <TextField
            label={K.amount}
            labelHidden
            placeholder={K.amount}
            inputMode="decimal"
            autoComplete="off"
            value={state.amount}
            onChange={state.setAmount}
            className="w-27.5"
          />
          <TextField
            label={K.title}
            labelHidden
            placeholder={K.title}
            autoComplete="off"
            value={state.title}
            onChange={state.setTitle}
            className="min-w-35 flex-1"
          />
          <Select
            label={K.category}
            labelHidden
            value={state.category}
            onChange={state.setCategory}
            options={state.categories.map((o) => ({ value: o.key, label: o.label }))}
          />
          <Button variant="primary" type="submit" disabled={state.busy} pending={state.adding}>
            {C.add}
          </Button>
        </form>
        {state.error && (
          <Notice tone="negative" className="mb-2.5">
            {state.error}
          </Notice>
        )}
        <div className={scrollCls(true)}>
          <table className={dataTableCls}>
            <thead>
              <tr>
                <th className={dataThCls()}>{K.date}</th>
                <th className={dataThCls()}>{K.title}</th>
                <th className={dataThCls()}>{K.category}</th>
                <th className={dataThCls(true)}>{K.amount}</th>
                <th className={dataThCls()} />
              </tr>
            </thead>
            <tbody>
              {d.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className={`${dataTdCls()} text-fg-muted`}>
                    {K.empty}
                  </td>
                </tr>
              ) : (
                d.rows.map((t) => (
                  <tr key={t.gid}>
                    <td className={dataTdCls()}>{t.date}</td>
                    <td className={dataTdCls()}>
                      {t.withdrawal ? DOWN : ""}
                      {t.title}
                    </td>
                    <td className={`${dataTdCls()} text-fg-muted`}>{t.category}</td>
                    <td
                      className={`${dataTdCls(true)} ${t.negative ? "text-negative" : "text-positive"}`}
                    >
                      {t.amount}
                    </td>
                    <td className={dataTdCls(true)}>
                      <Button
                        variant="icon"
                        title={C.remove}
                        label={`${C.remove}: ${t.title || K.cash}`}
                        disabled={state.busy}
                        onPress={() => state.deleteRow(t.gid)}
                      >
                        {REMOVE}
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </Drawer>
  );
}
