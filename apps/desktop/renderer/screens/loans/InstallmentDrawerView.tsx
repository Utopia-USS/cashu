import { Money as MoneyValue } from "@cashu/domain";
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import { Button, DateText, Modal, Money, Select, TextField } from "@cashu/ui";
import { useId } from "react";
import type { LoansState } from "./useLoansScreen.js";

export function InstallmentDrawerView({ state }: { state: LoansState }) {
  const hintId = useId();
  const row = state.matchingLoan;
  const stored = state.mode === "text" ? !!row?.paymentText : !!row?.paymentIbanTail;
  return state.privacy || state.drawer !== "payment" ? null : (
    <Modal
      label={S.payments}
      onClose={state.close}
      placement="center"
      width="sm"
      closeOnBackdrop={false}
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
            <Select
              label={S.loan}
              value={field.state.value}
              onChange={(value) => state.pickPayment(value)}
              options={state.rows.map((loan) => ({
                value: loan.accountId,
                label: loan.name ?? "",
              }))}
            />
          )}
        </state.paymentForm.Field>
        <state.paymentForm.Field name="mode">
          {(field) => (
            <Select
              label={S.method}
              value={field.state.value}
              onChange={(value) => field.handleChange(value === "iban" ? "iban" : "text")}
              options={[
                { value: "text", label: S.byPhrase },
                { value: "iban", label: S.byIban },
              ]}
            />
          )}
        </state.paymentForm.Field>
        {state.mode === "text" ? (
          <state.paymentForm.Field name="text">
            {(field) => (
              <div className="grid gap-1">
                <TextField
                  label={S.phrase}
                  describedBy={`${hintId}-phrase`}
                  value={field.state.value}
                  maxLength={200}
                  autoComplete="off"
                  onBlur={field.handleBlur}
                  onChange={(value) => field.handleChange(value)}
                />
                <span id={`${hintId}-phrase`} className="text-caption text-fg-muted">
                  {S.phraseHint}
                </span>
              </div>
            )}
          </state.paymentForm.Field>
        ) : (
          <state.paymentForm.Field name="iban">
            {(field) => (
              <div className="grid gap-1">
                <TextField
                  label={S.ibanLabel}
                  describedBy={`${hintId}-iban`}
                  value={field.state.value}
                  autoComplete="off"
                  onBlur={field.handleBlur}
                  onChange={(value) => field.handleChange(value)}
                />
                {row?.paymentIbanTail && <span>{S.storedIban(row.paymentIbanTail)}</span>}
                <span id={`${hintId}-iban`} className="text-caption text-fg-muted">
                  {S.ibanHint}
                </span>
              </div>
            )}
          </state.paymentForm.Field>
        )}
        {stored && (
          <Button
            variant="danger"
            disabled={state.busy}
            onPress={() => void state.submitPayment(true)}
          >
            {S.clear}
          </Button>
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
                <Button onPress={() => state.setText(candidate.counterparty)}>{S.use}</Button>
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
          <Button disabled={state.busy} onPress={state.close}>
            {C.cancel}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={
              state.busy ||
              row === null ||
              !(state.mode === "text" ? state.text : state.iban).trim()
            }
          >
            {state.busy ? S.saving : C.save}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
