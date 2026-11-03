import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import { Money } from "@cashu/ui";
import { useEffect, useRef } from "react";
import { L } from "./Loans.strings.js";
import type { LoansState } from "./useLoansScreen.js";

export function LoanDrawerView({ state }: { state: LoansState }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (state.drawer === "loan" && !state.privacy && !el?.open) el?.showModal();
    if ((state.drawer !== "loan" || state.privacy) && el?.open) el.close();
  }, [state.drawer, state.privacy]);
  return state.privacy ? null : (
    <dialog
      ref={ref}
      aria-label={S.addLoan}
      onCancel={(e) => {
        e.preventDefault();
        state.close();
      }}
      className="m-auto max-h-full w-full max-w-xl overflow-auto rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
    >
      <h2 className="text-headline">{S.addLoan}</h2>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void state.submitLoan();
        }}
      >
        <state.loanForm.Field name="name">
          {(field) => (
            <label className="flex flex-col gap-1">
              {S.name}
              <input
                autoComplete="off"
                maxLength={120}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              />
            </label>
          )}
        </state.loanForm.Field>
        <state.loanForm.Field name="type">
          {(field) => (
            <label className="flex flex-col gap-1">
              {S.type}
              <select
                value={field.state.value}
                onChange={(e) =>
                  field.handleChange(e.target.value === "loan" ? "loan" : "mortgage")
                }
                className="rounded-sm border border-border bg-surface p-2"
              >
                <option value="mortgage">{S.mortgage}</option>
                <option value="loan">{S.loan}</option>
              </select>
            </label>
          )}
        </state.loanForm.Field>
        {(
          [
            ["principal", S.principal],
            ["annualRate", S.rate],
            ["term", S.term],
            ["currency", S.currency],
          ] as const
        ).map(([key, label]) => (
          <state.loanForm.Field key={key} name={key}>
            {(field) => (
              <label className="flex flex-col gap-1">
                {label}
                <input
                  value={field.state.value}
                  inputMode={key === "currency" ? "text" : "decimal"}
                  onBlur={field.handleBlur}
                  onChange={(e) =>
                    field.handleChange(
                      key === "currency" ? e.target.value.toUpperCase() : e.target.value,
                    )
                  }
                  className="rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </state.loanForm.Field>
        ))}
        <state.loanForm.Field name="unit">
          {(field) => (
            <label className="flex flex-col gap-1">
              {S.unit}
              <select
                value={field.state.value}
                onChange={(e) =>
                  field.handleChange(e.target.value === "months" ? "months" : "years")
                }
                className="rounded-sm border border-border bg-surface p-2"
              >
                <option value="years">{S.years}</option>
                <option value="months">{S.months}</option>
              </select>
            </label>
          )}
        </state.loanForm.Field>
        {(
          [
            ["startDate", S.firstInstallment],
            ["originationDate", S.origination],
          ] as const
        ).map(([key, label]) => (
          <state.loanForm.Field key={key} name={key}>
            {(field) => (
              <label className="flex flex-col gap-1">
                {label}
                <input
                  type="date"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </state.loanForm.Field>
        ))}
        {state.preview && (
          <p className="sm:col-span-2">
            {L.preview}: <Money value={state.preview} />
          </p>
        )}
        <p className="text-caption text-fg-muted sm:col-span-2">{S.variableRate}</p>
        {state.error && (
          <p role="alert" className="text-negative sm:col-span-2">
            {state.error}
          </p>
        )}
        <footer className="flex justify-end gap-3 sm:col-span-2">
          <button type="button" disabled={state.busy} onClick={state.close}>
            {C.cancel}
          </button>
          <button type="submit" disabled={state.busy}>
            {state.busy ? S.saving : C.add}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
