import { Button, Modal, Select, TextField } from "@cashu/ui";
import { useId } from "react";
import { ImportStepsView } from "./ImportStepsView.js";
import { I } from "./Portfolio.strings.js";
import { TransactionsView } from "./TransactionsView.js";
import { fieldsForTransaction, transactionTypes } from "./usePortfolioForms.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

/** Owner forms retain drafts on refusal; capability-unavailable import remains visibly separate. */
export function PortfolioDrawersView({ state }: { state: PortfolioScreenState }) {
  const errorId = useId();
  const validationId = useId();
  const hintId = useId();
  if (state.privacy || state.drawer === null) return null;
  const title =
    state.drawer === "account"
      ? I.addAccount
      : state.drawer === "transaction"
        ? I.addTransaction
        : state.drawer === "thesis"
          ? I.thesis
          : state.drawer === "classification"
            ? I.classify
            : state.drawer === "note"
              ? I.noteTitle
              : state.drawer === "transactions"
                ? I.transactions
                : I.import;
  const forms = state.forms;
  const transaction = state.transactionValues;
  const submit = () =>
    state.drawer === "account"
      ? forms.account.handleSubmit()
      : state.drawer === "transaction"
        ? forms.transaction.handleSubmit()
        : state.drawer === "thesis"
          ? forms.thesis.handleSubmit()
          : state.drawer === "note"
            ? forms.note.handleSubmit()
            : forms.classification.handleSubmit();
  return (
    <Modal
      label={title}
      describedBy={state.error ? `${validationId} ${errorId}` : validationId}
      onClose={state.close}
      placement="center"
      width={state.drawer === "transactions" ? "2xl" : "sm"}
      closeOnBackdrop={false}
    >
      <h2 className="text-title font-strong">{title}</h2>
      <form
        className="mt-4 grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!state.busy && state.drawer !== "import") void submit();
        }}
      >
        {state.drawer === "account" && (
          <>
            <forms.account.Field name="broker">
              {(field) => (
                <Select
                  label={I.broker}
                  describedBy={validationId}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={state.brokers.map((broker) => ({
                    value: broker.id,
                    label: broker.name,
                  }))}
                />
              )}
            </forms.account.Field>
            {(
              [
                ["name", I.name],
                ["currency", I.currency],
              ] as const
            ).map(([key, label]) => (
              <forms.account.Field key={key} name={key}>
                {(field) => (
                  <TextField
                    label={label}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    describedBy={state.error ? `${validationId} ${errorId}` : validationId}
                  />
                )}
              </forms.account.Field>
            ))}
            <forms.account.Field name="wrapper">
              {(field) => (
                <Select
                  label={I.wrapper}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={["regular", "ike", "ikze", "oipe", "other"].map((wrapper) => ({
                    value: wrapper,
                    label: wrapper,
                  }))}
                />
              )}
            </forms.account.Field>
          </>
        )}
        {state.drawer === "transaction" && (
          <>
            <forms.transaction.Field name="account">
              {(field) => (
                <Select
                  label={I.account}
                  value={field.state.value}
                  onChange={(value) => {
                    field.handleChange(value);
                    const account = state.portfolio.accounts.find((row) => row.gid === value);
                    forms.transaction.setFieldValue("cashCurrency", account?.currency ?? "");
                    forms.transaction.setFieldValue("fxRate", "");
                  }}
                  options={state.portfolio.accounts.map((account) => ({
                    value: account.gid,
                    label: `${account.name} · ${account.currency}`,
                  }))}
                />
              )}
            </forms.transaction.Field>
            <forms.transaction.Field name="type">
              {(field) => (
                <Select
                  label={I.transactionType}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={transactionTypes.map((type) => ({
                    value: type,
                    label: type === "fx_conversion" ? I.fxLeg : state.transactionTypeLabel(type),
                  }))}
                />
              )}
            </forms.transaction.Field>
            {transaction.type === "fx_conversion" && (
              <p id={hintId} className="text-caption text-fg-muted">
                {I.fxHelp}
              </p>
            )}
            <forms.transaction.Field name="tradeDate">
              {(field) => (
                <TextField
                  label={I.date}
                  type="date"
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </forms.transaction.Field>
            {!["deposit", "withdrawal", "fx_conversion"].includes(transaction.type) && (
              <>
                <forms.transaction.Field name="instrument">
                  {(field) => (
                    <Select
                      label={I.instrument}
                      value={field.state.value}
                      onChange={(value) => {
                        field.handleChange(value);
                        forms.transaction.setFieldValue("fxRate", "");
                        const selected = state.instrumentOptions.find((row) => row.id === value);
                        if (selected)
                          forms.transaction.setFieldValue("currency", selected.currency);
                      }}
                      options={[
                        { value: "", label: I.newInstrument },
                        ...state.instrumentOptions.map((instrument) => ({
                          value: instrument.id,
                          label: instrument.label,
                        })),
                      ]}
                    />
                  )}
                </forms.transaction.Field>
                {!transaction.instrument &&
                  (
                    [
                      ["symbol", I.symbol],
                      ["isin", I.isin],
                      ["name", I.name],
                      ["assetClass", I.assetClass],
                    ] as const
                  ).map(([key, label]) => (
                    <forms.transaction.Field key={key} name={key}>
                      {(field) => (
                        <TextField
                          label={label}
                          value={field.state.value}
                          onChange={field.handleChange}
                        />
                      )}
                    </forms.transaction.Field>
                  ))}
              </>
            )}
            <forms.transaction.Field name="currency">
              {(field) => (
                <TextField
                  label={I.currency}
                  value={field.state.value}
                  describedBy={transaction.type === "fx_conversion" ? hintId : undefined}
                  onChange={field.handleChange}
                />
              )}
            </forms.transaction.Field>
            {!["split", "transfer_in", "transfer_out", "adjustment", "fx_conversion"].includes(
              transaction.type,
            ) && (
              <forms.transaction.Field name="cashCurrency">
                {(field) => (
                  <TextField
                    label={I.cashCurrency}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </forms.transaction.Field>
            )}
            {fieldsForTransaction(transaction.type).map((key) => (
              <forms.transaction.Field key={key} name={key}>
                {(field) => (
                  <TextField
                    label={
                      {
                        quantity: I.quantity,
                        price: I.price,
                        grossAmount: I.gross,
                        fee: I.fees,
                        tax: I.tax,
                        cashAmount: I.cashAmount,
                        fxRate: I.fxRate,
                        splitRatio: I.splitRatio,
                      }[key]
                    }
                    inputMode="decimal"
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    describedBy={state.error ? `${validationId} ${errorId}` : validationId}
                  />
                )}
              </forms.transaction.Field>
            ))}
            <forms.transaction.Field name="note">
              {(field) => (
                <TextField
                  label={I.note}
                  multiline
                  value={field.state.value}
                  onChange={field.handleChange}
                />
              )}
            </forms.transaction.Field>
          </>
        )}
        {state.drawer === "thesis" && (
          <>
            <forms.thesis.Field name="entryType">
              {(field) => (
                <Select
                  label={I.entryType}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={["sentiment_correction", "trend", "special_situation"].map((value) => ({
                    value,
                    label: value,
                  }))}
                />
              )}
            </forms.thesis.Field>
            {(
              [
                ["thesis", I.thesis],
                ["invalidation", I.invalidation],
                ["exitPlan", I.exitPlan],
                ["sizePlan", I.sizePlan],
              ] as const
            ).map(([key, label]) => (
              <forms.thesis.Field key={key} name={key}>
                {(field) => (
                  <TextField
                    label={label}
                    multiline
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                    describedBy={state.error ? `${validationId} ${errorId}` : validationId}
                  />
                )}
              </forms.thesis.Field>
            ))}
            <forms.thesis.Field name="reviewed">
              {(field) => (
                <Select
                  label={I.reviewed}
                  value={field.state.value}
                  onChange={field.handleChange}
                  options={[
                    { value: "no", label: I.no },
                    { value: "yes", label: I.yes },
                  ]}
                />
              )}
            </forms.thesis.Field>
          </>
        )}
        {state.drawer === "note" &&
          (
            [
              ["note", I.note],
              ["tags", I.tags],
            ] as const
          ).map(([key, label]) => (
            <forms.note.Field key={key} name={key}>
              {(field) => (
                <TextField
                  label={label}
                  multiline
                  value={field.state.value}
                  onChange={field.handleChange}
                  describedBy={state.error ? `${validationId} ${errorId}` : validationId}
                />
              )}
            </forms.note.Field>
          ))}
        {state.drawer === "classification" &&
          (
            [
              ["name", I.name],
              ["assetClass", I.assetClass],
              ["valuationMode", I.valuation],
              ["region", I.region],
              ["sector", I.sector],
              ["status", I.status],
              ["segment", I.segment],
              ["tags", I.tags],
              ["aliases", I.aliases],
            ] as const
          ).map(([key, label]) => (
            <forms.classification.Field key={key} name={key}>
              {(field) => (
                <TextField
                  label={label}
                  value={field.state.value}
                  onChange={field.handleChange}
                  describedBy={state.error ? `${validationId} ${errorId}` : validationId}
                />
              )}
            </forms.classification.Field>
          ))}
        {state.drawer === "import" && <ImportStepsView state={state} />}
        {state.drawer === "transactions" && <TransactionsView state={state} />}
        {state.drawer === "transaction" && (
          <forms.transaction.Subscribe selector={(form) => form.errors}>
            {(errors) => <ValidationMessage errors={errors} id={validationId} />}
          </forms.transaction.Subscribe>
        )}
        {state.drawer === "account" && (
          <forms.account.Subscribe selector={(form) => form.errors}>
            {(errors) => <ValidationMessage errors={errors} id={validationId} />}
          </forms.account.Subscribe>
        )}
        {state.drawer === "thesis" && (
          <forms.thesis.Subscribe selector={(form) => form.errors}>
            {(errors) => <ValidationMessage errors={errors} id={validationId} />}
          </forms.thesis.Subscribe>
        )}
        {state.drawer === "note" && (
          <forms.note.Subscribe selector={(form) => form.errors}>
            {(errors) => <ValidationMessage errors={errors} id={validationId} />}
          </forms.note.Subscribe>
        )}
        {state.drawer === "classification" && (
          <forms.classification.Subscribe selector={(form) => form.errors}>
            {(errors) => <ValidationMessage errors={errors} id={validationId} />}
          </forms.classification.Subscribe>
        )}
        {(state.drawer === "transactions" || state.drawer === "import") && (
          <p id={validationId} className="sr-only" />
        )}
        {state.error && (
          <p role="alert" id={errorId}>
            {state.error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <Button disabled={state.busy} onPress={state.close}>
            {I.cancel}
          </Button>
          {state.drawer !== "import" && state.drawer !== "transactions" && (
            <Button type="submit" variant="primary" disabled={state.busy}>
              {state.busy ? I.pending : I.save}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function ValidationMessage({ errors, id }: { errors: readonly unknown[]; id: string }) {
  const invalid = errors.some(Boolean);
  return (
    <p
      id={id}
      role={invalid ? "alert" : undefined}
      className={invalid ? "text-negative" : "sr-only"}
    >
      {invalid ? I.invalid : ""}
    </p>
  );
}
