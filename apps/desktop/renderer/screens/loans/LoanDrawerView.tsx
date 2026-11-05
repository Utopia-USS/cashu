import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import { Button, Modal, Money, Select, TextField } from "@cashu/ui";
import { L } from "./Loans.strings.js";
import type { LoansState } from "./useLoansScreen.js";

export function LoanDrawerView({ state }: { state: LoansState }) {
  return state.privacy || state.drawer !== "loan" ? null : (
    <Modal
      label={S.addLoan}
      onClose={state.close}
      placement="center"
      width="sm"
      closeOnBackdrop={false}
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
            <TextField
              label={S.name}
              autoComplete="off"
              maxLength={120}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(value) => field.handleChange(value)}
            />
          )}
        </state.loanForm.Field>
        <state.loanForm.Field name="type">
          {(field) => (
            <Select
              label={S.type}
              value={field.state.value}
              onChange={(value) => field.handleChange(value === "loan" ? "loan" : "mortgage")}
              options={[
                { value: "mortgage", label: S.mortgage },
                { value: "loan", label: S.loan },
              ]}
            />
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
              <TextField
                label={label}
                value={field.state.value}
                inputMode={key === "currency" ? "text" : "decimal"}
                onBlur={field.handleBlur}
                onChange={(value) =>
                  field.handleChange(key === "currency" ? value.toUpperCase() : value)
                }
              />
            )}
          </state.loanForm.Field>
        ))}
        <state.loanForm.Field name="unit">
          {(field) => (
            <Select
              label={S.unit}
              value={field.state.value}
              onChange={(value) => field.handleChange(value === "months" ? "months" : "years")}
              options={[
                { value: "years", label: S.years },
                { value: "months", label: S.months },
              ]}
            />
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
              <TextField
                label={label}
                type="date"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(value) => field.handleChange(value)}
              />
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
          <Button disabled={state.busy} onPress={state.close}>
            {C.cancel}
          </Button>
          <Button variant="primary" type="submit" disabled={state.busy}>
            {state.busy ? S.saving : C.add}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
