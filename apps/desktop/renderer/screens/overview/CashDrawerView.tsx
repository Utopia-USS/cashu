import { budget, Money as MoneyValue } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { Button, DateText, Modal, Money, Select, TextField } from "@cashu/ui";
import { useState } from "react";
import { W } from "./OverviewWidgets.strings.js";
import type { CashDrawerState } from "./useCashDrawer.js";

export interface CashDrawerViewProps {
  state: CashDrawerState;
  privacy: boolean;
}

/** Pure local drawer; the screen hook owns every command and validates the active vault. */
export function CashDrawerView({ state, privacy }: CashDrawerViewProps) {
  const [page, setPage] = useState(0);
  const rows = state.wallet.transactions;
  const lastPage = Math.max(0, Math.ceil(rows.length / 40) - 1);
  const shownPage = Math.min(page, lastPage);
  if (!state.open) return null;
  return (
    <Modal
      label={W.wallet}
      onClose={() => state.setOpen(false)}
      placement="center"
      width="md"
      closeOnBackdrop={false}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-headline font-strong">{W.wallet}</h2>
          <Money value={new MoneyValue(state.wallet.balance, state.wallet.currency)} size="title" />
        </div>
        <Button onPress={() => state.setOpen(false)} label={W.close}>
          {W.close}
        </Button>
      </div>
      <div className="mb-5 flex flex-wrap gap-4 text-caption text-fg-muted">
        <span>
          {W.withdrawnSpent}:{" "}
          <Money value={new MoneyValue(state.wallet.withdrawals, state.wallet.currency)} />
          {" / "}
          <Money value={new MoneyValue(state.wallet.expenses, state.wallet.currency)} />
        </span>
      </div>
      <form
        className="mb-5 grid gap-3 sm:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void state.submit();
        }}
      >
        <TextField
          label={W.amount}
          inputMode="decimal"
          autoComplete="off"
          value={state.amount}
          onChange={state.setAmount}
        />
        <TextField
          label={W.title}
          autoComplete="off"
          value={state.title}
          onChange={state.setTitle}
          className="sm:col-span-2"
        />
        <Select
          label={W.category}
          value={state.category}
          onChange={state.setCategory}
          options={state.categories.map((option) => ({ value: option.key, label: option.label }))}
        />
        <Button variant="primary" type="submit" disabled={state.busy} className="sm:col-span-4">
          {W.add}
        </Button>
      </form>
      {state.error && (
        <p role="alert" className="mb-3 text-negative">
          {state.error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-fg-muted">{W.noCash}</p>
      ) : (
        <div className="max-h-80 overflow-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border text-fg-muted">
                <th scope="col">{W.title}</th>
                <th scope="col">{W.category}</th>
                <th scope="col">{W.amount}</th>
                <th scope="col">{W.remove}</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(shownPage * 40, (shownPage + 1) * 40).map((row) => (
                <tr key={row.gid} className="border-b border-border">
                  <td>
                    <DateText value={row.date} /> {privacy ? "•••" : (row.title ?? "-")}
                  </td>
                  <td>{row.category ? budget.categoryLabel(row.category, lang()) : "-"}</td>
                  <td>
                    <Money value={new MoneyValue(row.amount, state.wallet.currency)} />
                  </td>
                  <td>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={state.busy}
                      onPress={() => void state.deleteRow(row.gid)}
                      label={`${W.remove}: ${privacy ? W.cash : (row.title ?? W.cash)}`}
                    >
                      {W.remove}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastPage > 0 && (
            <div className="mt-3 flex justify-between gap-3">
              <Button disabled={shownPage === 0} onPress={() => setPage(shownPage - 1)}>
                {"<"}
              </Button>
              <span>
                {shownPage + 1} / {lastPage + 1}
              </span>
              <Button disabled={shownPage === lastPage} onPress={() => setPage(shownPage + 1)}>
                {">"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
