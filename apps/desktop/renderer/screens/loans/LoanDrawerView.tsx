// A new loan (ab24ab6 modules/loans/Drawers.tsx `LoanDrawer`): the fields of `cashu loans add` with the
// installment preview in the footer. Pure; refused (not rendered) in privacy mode by the hook.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/loans/Drawers.strings";
import { Button, Drawer, FieldNote, FormRow, Notice, Seg, Select, TextField } from "@cashu/ui";
import type { TermUnit } from "./loanForm.js";
import type { LoansState } from "./useLoansScreen.js";

/** Old `.field` frame around a control that is not a text field (the type switch): 12px muted caption, 4px gap. */
const fieldCls = "mb-3 grid gap-1 text-xs text-fg-muted";

export function LoanDrawerView({ state }: { state: LoansState }) {
  if (state.privacy || state.drawer?.kind !== "loan") return null;
  const { form, set, errors } = state.loan;
  const fe = (k: keyof typeof errors) =>
    errors[k] ? <FieldNote tone="negative">{errors[k]}</FieldNote> : undefined;
  return (
    <Drawer
      title={S.addLoan}
      label={S.addLoan}
      width={520}
      onClose={state.close}
      footer={
        <>
          <FieldNote>{state.loan.preview}</FieldNote>
          <span className="flex-1" />
          <Button onPress={state.close}>{C.cancel}</Button>
          <Button variant="primary" disabled={state.busy} onPress={state.loan.save}>
            {C.add}
          </Button>
        </>
      }
    >
      {state.err && <Notice tone="negative">{state.err}</Notice>}
      <TextField
        id="ln-name"
        label={S.name}
        value={form.name}
        placeholder={S.namePlaceholder}
        maxLength={60}
        autoComplete="off"
        autoFocus
        onChange={(v) => set("name", v)}
        after={fe("name")}
        className="mb-3"
      />
      <div className={fieldCls}>
        <span>{S.type}</span>
        <div>
          <Seg<"mortgage" | "loan">
            label={S.type}
            items={[
              [S.mortgage, "mortgage"],
              [S.loan, "loan"],
            ]}
            value={form.type}
            onChange={(v) => set("type", v)}
            title={S.typeTitle}
          />
        </div>
      </div>
      <FormRow>
        <TextField
          id="ln-p"
          label={S.principal}
          numeric
          inputMode="decimal"
          autoComplete="off"
          value={form.principal}
          onChange={(v) => set("principal", v)}
          after={fe("principal")}
          className="mb-3"
        />
        <Select
          id="ln-c"
          label={S.currency}
          value={form.currency}
          onChange={(v) => set("currency", v)}
          options={state.loan.currencies.map((c) => ({ value: c, label: c }))}
          className="mb-3"
        />
      </FormRow>
      <FormRow>
        <TextField
          id="ln-r"
          label={S.rate}
          numeric
          inputMode="decimal"
          autoComplete="off"
          placeholder={S.ratePlaceholder}
          value={form.annualRate}
          onChange={(v) => set("annualRate", v)}
          after={fe("rate")}
          className="mb-3"
        />
        <TextField
          id="ln-t"
          label={S.term}
          numeric
          inputMode="numeric"
          autoComplete="off"
          value={form.term}
          onChange={(v) => set("term", v)}
          trailing={
            <Seg<TermUnit>
              quiet
              label={S.unit}
              items={[
                [S.years, "years"],
                [S.months, "months"],
              ]}
              value={form.unit}
              onChange={(v) => set("unit", v)}
            />
          }
          after={fe("term")}
          className="mb-3"
        />
      </FormRow>
      <FieldNote className="-mt-1.5 mb-3 block">{S.variableRate}</FieldNote>
      <FormRow>
        <TextField
          id="ln-s"
          label={S.firstInstallment}
          type="date"
          value={form.startDate}
          onChange={(v) => set("startDate", v)}
          after={fe("start")}
          className="mb-3"
        />
        <TextField
          id="ln-o"
          label={S.origination}
          type="date"
          value={form.originationDate}
          title={S.originationTitle}
          onChange={(v) => set("originationDate", v)}
          after={fe("origination")}
          className="mb-3"
        />
      </FormRow>
    </Drawer>
  );
}
