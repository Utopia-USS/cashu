import { Money as MoneyValue } from "@cashu/domain";
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import { DateText, Money } from "@cashu/ui";
import { useEffect, useId, useRef } from "react";
import type { LoansState } from "./useLoansScreen.js";

export function InstallmentDrawerView({ state }: { state: LoansState }) {
  const ref = useRef<HTMLDialogElement>(null);
  const hintId = useId();
  useEffect(() => {
    const el = ref.current;
    if (state.drawer === "payment" && !state.privacy && !el?.open) el?.showModal();
    if ((state.drawer !== "payment" || state.privacy) && el?.open) el.close();
  }, [state.drawer, state.privacy]);
  const row = state.matchingLoan;
  const stored = state.mode === "text" ? !!row?.paymentText : !!row?.paymentIbanTail;
  return state.privacy ? null : (
    <dialog
      ref={ref}
      aria-label={S.payments}
      onCancel={(e) => {
        e.preventDefault();
        state.close();
      }}
      className="m-auto max-h-full w-full max-w-xl overflow-auto rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken"
    >
      <h2>{S.payments}</h2>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void state.submitPayment();
        }}
      >
        <state.paymentForm.Field name="account">
          {(field) => (
            <label className="flex flex-col gap-1">
              {S.loan}
              <select
                value={field.state.value}
                onChange={(e) => state.pickPayment(e.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              >
                {state.rows.map((loan) => (
                  <option key={loan.id} value={loan.accountId}>
                    {loan.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </state.paymentForm.Field>
        <state.paymentForm.Field name="mode">
          {(field) => (
            <label className="flex flex-col gap-1">
              {S.method}
              <select
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value === "iban" ? "iban" : "text")}
                className="rounded-sm border border-border bg-surface p-2"
              >
                <option value="text">{S.byPhrase}</option>
                <option value="iban">{S.byIban}</option>
              </select>
            </label>
          )}
        </state.paymentForm.Field>
        {state.mode === "text" ? (
          <state.paymentForm.Field name="text">
            {(field) => (
              <label className="flex flex-col gap-1">
                {S.phrase}
                <input
                  aria-label={S.phrase}
                  aria-describedby={`${hintId}-phrase`}
                  value={field.state.value}
                  maxLength={200}
                  autoComplete="off"
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="rounded-sm border border-border bg-surface p-2"
                />
                <span id={`${hintId}-phrase`} className="text-caption text-fg-muted">
                  {S.phraseHint}
                </span>
              </label>
            )}
          </state.paymentForm.Field>
        ) : (
          <state.paymentForm.Field name="iban">
            {(field) => (
              <label className="flex flex-col gap-1">
                {S.ibanLabel}
                {row?.paymentIbanTail && <span>{S.storedIban(row.paymentIbanTail)}</span>}
                <input
                  aria-label={S.ibanLabel}
                  aria-describedby={`${hintId}-iban`}
                  value={field.state.value}
                  autoComplete="off"
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                  className="rounded-sm border border-border bg-surface p-2"
                />
                <span id={`${hintId}-iban`} className="text-caption text-fg-muted">
                  {S.ibanHint}
                </span>
              </label>
            )}
          </state.paymentForm.Field>
        )}
        {stored && (
          <button
            type="button"
            disabled={state.busy}
            onClick={() => void state.submitPayment(true)}
          >
            {S.clear}
          </button>
        )}
        {state.mode === "text" && state.candidates.length > 0 && (
          <section>
            <h3>{S.recent}</h3>
            {state.candidates.map((candidate) => (
              <div
                key={`${candidate.counterparty}-${candidate.currency}-${candidate.typicalAmount.format("f")}`}
                className="flex justify-between gap-3 py-2"
              >
                <span>
                  {candidate.counterparty}
                  <span className="block text-caption text-fg-muted">
                    <Money
                      value={new MoneyValue(candidate.typicalAmount.abs(), candidate.currency)}
                    />{" "}
                    · <DateText value={candidate.lastDate} />
                  </span>
                </span>
                <button type="button" onClick={() => state.setText(candidate.counterparty)}>
                  {S.use}
                </button>
              </div>
            ))}
          </section>
        )}
        {row && <p role="status">{S.matched(row.matched)}</p>}
        {state.error && (
          <p role="alert" className="text-negative">
            {state.error}
          </p>
        )}
        <footer className="flex justify-end gap-3">
          <button type="button" disabled={state.busy} onClick={state.close}>
            {C.cancel}
          </button>
          <button
            type="submit"
            disabled={
              state.busy ||
              row === null ||
              !(state.mode === "text" ? state.text : state.iban).trim()
            }
          >
            {state.busy ? S.saving : C.save}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
