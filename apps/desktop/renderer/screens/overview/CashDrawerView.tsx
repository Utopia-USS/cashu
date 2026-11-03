import { budget, Money as MoneyValue } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { DateText, Money } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { W } from "./OverviewWidgets.strings.js";
import type { CashDrawerState } from "./useCashDrawer.js";

export interface CashDrawerViewProps {
  state: CashDrawerState;
  privacy: boolean;
}

/** Pure local drawer; the screen hook owns every command and validates the active vault. */
export function CashDrawerView({ state, privacy }: CashDrawerViewProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [page, setPage] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    if (state.open && !element?.open) element?.showModal();
    if (!state.open && element?.open) element.close();
  }, [state.open]);
  const rows = state.wallet.transactions;
  const lastPage = Math.max(0, Math.ceil(rows.length / 40) - 1);
  const shownPage = Math.min(page, lastPage);
  return (
    <dialog
      ref={dialog}
      aria-label={W.wallet}
      onCancel={(event) => {
        event.preventDefault();
        state.setOpen(false);
      }}
      onClose={() => state.setOpen(false)}
      className="m-auto max-h-full w-full max-w-2xl rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-headline font-strong">{W.wallet}</h2>
          <Money value={new MoneyValue(state.wallet.balance, state.wallet.currency)} size="title" />
        </div>
        <button type="button" onClick={() => state.setOpen(false)} aria-label={W.close}>
          {W.close}
        </button>
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
        <label className="flex flex-col gap-1">
          {W.amount}
          <input
            inputMode="decimal"
            autoComplete="off"
            value={state.amount}
            onChange={(event) => state.setAmount(event.target.value)}
            className="rounded-sm border border-border bg-surface p-2"
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          {W.title}
          <input
            autoComplete="off"
            value={state.title}
            onChange={(event) => state.setTitle(event.target.value)}
            className="rounded-sm border border-border bg-surface p-2"
          />
        </label>
        <label className="flex flex-col gap-1">
          {W.category}
          <select
            value={state.category}
            onChange={(event) => state.setCategory(event.target.value)}
            className="rounded-sm border border-border bg-surface p-2"
          >
            {state.categories.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          disabled={state.busy}
          className="rounded-sm bg-accent p-2 text-fg-inverse sm:col-span-4"
        >
          {W.add}
        </button>
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
                    <button
                      type="button"
                      disabled={state.busy}
                      onClick={() => void state.deleteRow(row.gid)}
                      aria-label={`${W.remove}: ${privacy ? W.cash : (row.title ?? W.cash)}`}
                      className="text-negative"
                    >
                      {W.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lastPage > 0 && (
            <div className="mt-3 flex justify-between gap-3">
              <button
                type="button"
                disabled={shownPage === 0}
                onClick={() => setPage(shownPage - 1)}
              >
                {"<"}
              </button>
              <span>
                {shownPage + 1} / {lastPage + 1}
              </span>
              <button
                type="button"
                disabled={shownPage === lastPage}
                onClick={() => setPage(shownPage + 1)}
              >
                {">"}
              </button>
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
