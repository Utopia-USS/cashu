import { useEffect, useId, useRef } from "react";
import { ImportStepsView } from "./ImportStepsView.js";
import { I } from "./Portfolio.strings.js";
import { investmentButton } from "./PortfolioView.js";
import { TransactionsView } from "./TransactionsView.js";
import { fieldsForTransaction, transactionTypes } from "./usePortfolioForms.js";
import type { PortfolioScreenState } from "./usePortfolioScreen.js";

const input = "w-full rounded-sm border border-border bg-surface p-2";

/** Owner forms retain drafts on refusal; capability-unavailable import remains visibly separate. */
export function PortfolioDrawersView({ state }: { state: PortfolioScreenState }) {
  const ref = useRef<HTMLDialogElement>(null);
  const errorId = useId();
  const validationId = useId();
  const hintId = useId();
  useEffect(() => {
    const element = ref.current;
    if (state.drawer !== null && !state.privacy && !element?.open) element?.showModal();
    if ((state.drawer === null || state.privacy) && element?.open) element.close();
  }, [state.drawer, state.privacy]);
  if (state.privacy) return null;
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
    <dialog
      ref={ref}
      aria-label={title}
      aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
      onCancel={(event) => {
        event.preventDefault();
        state.close();
      }}
      className={`m-auto max-h-full w-full ${state.drawer === "transactions" ? "max-w-6xl" : "max-w-xl"} overflow-auto rounded-lg border border-border bg-surface-overlay p-6 text-fg backdrop:bg-surface-sunken`}
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
                <label>
                  {I.broker}
                  <select
                    aria-describedby={validationId}
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {state.brokers.map((broker) => (
                      <option key={broker.id} value={broker.id}>
                        {broker.name}
                      </option>
                    ))}
                  </select>
                </label>
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
                  <label>
                    {label}
                    <input
                      className={input}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
                    />
                  </label>
                )}
              </forms.account.Field>
            ))}
            <forms.account.Field name="wrapper">
              {(field) => (
                <label>
                  {I.wrapper}
                  <select
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {["regular", "ike", "ikze", "oipe", "other"].map((wrapper) => (
                      <option key={wrapper}>{wrapper}</option>
                    ))}
                  </select>
                </label>
              )}
            </forms.account.Field>
          </>
        )}
        {state.drawer === "transaction" && (
          <>
            <forms.transaction.Field name="account">
              {(field) => (
                <label>
                  {I.account}
                  <select
                    className={input}
                    value={field.state.value}
                    onChange={(event) => {
                      field.handleChange(event.target.value);
                      const account = state.portfolio.accounts.find(
                        (row) => row.gid === event.target.value,
                      );
                      forms.transaction.setFieldValue("cashCurrency", account?.currency ?? "");
                      forms.transaction.setFieldValue("fxRate", "");
                    }}
                  >
                    {state.portfolio.accounts.map((account) => (
                      <option key={account.gid} value={account.gid}>
                        {account.name} · {account.currency}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </forms.transaction.Field>
            <forms.transaction.Field name="type">
              {(field) => (
                <label>
                  {I.transactionType}
                  <select
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {transactionTypes.map((type) => (
                      <option key={type} value={type}>
                        {type === "fx_conversion" ? I.fxLeg : state.transactionTypeLabel(type)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </forms.transaction.Field>
            {transaction.type === "fx_conversion" && (
              <p id={hintId} className="text-caption text-fg-muted">
                {I.fxHelp}
              </p>
            )}
            <forms.transaction.Field name="tradeDate">
              {(field) => (
                <label>
                  {I.date}
                  <input
                    className={input}
                    type="date"
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </label>
              )}
            </forms.transaction.Field>
            {!["deposit", "withdrawal", "fx_conversion"].includes(transaction.type) && (
              <>
                <forms.transaction.Field name="instrument">
                  {(field) => (
                    <label>
                      {I.instrument}
                      <select
                        className={input}
                        value={field.state.value}
                        onChange={(event) => {
                          field.handleChange(event.target.value);
                          forms.transaction.setFieldValue("fxRate", "");
                          const selected = state.instrumentOptions.find(
                            (row) => row.id === event.target.value,
                          );
                          if (selected)
                            forms.transaction.setFieldValue("currency", selected.currency);
                        }}
                      >
                        <option value="">{I.newInstrument}</option>
                        {state.instrumentOptions.map((instrument) => (
                          <option key={instrument.id} value={instrument.id}>
                            {instrument.label}
                          </option>
                        ))}
                      </select>
                    </label>
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
                        <label>
                          {label}
                          <input
                            className={input}
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                          />
                        </label>
                      )}
                    </forms.transaction.Field>
                  ))}
              </>
            )}
            <forms.transaction.Field name="currency">
              {(field) => (
                <label>
                  {I.currency}
                  <input
                    className={input}
                    value={field.state.value}
                    aria-describedby={transaction.type === "fx_conversion" ? hintId : undefined}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </label>
              )}
            </forms.transaction.Field>
            {!["split", "transfer_in", "transfer_out", "adjustment", "fx_conversion"].includes(
              transaction.type,
            ) && (
              <forms.transaction.Field name="cashCurrency">
                {(field) => (
                  <label>
                    {I.cashCurrency}
                    <input
                      className={input}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                  </label>
                )}
              </forms.transaction.Field>
            )}
            {fieldsForTransaction(transaction.type).map((key) => (
              <forms.transaction.Field key={key} name={key}>
                {(field) => (
                  <label>
                    {
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
                    <input
                      className={input}
                      inputMode="decimal"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
                    />
                  </label>
                )}
              </forms.transaction.Field>
            ))}
            <forms.transaction.Field name="note">
              {(field) => (
                <label>
                  {I.note}
                  <textarea
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                </label>
              )}
            </forms.transaction.Field>
          </>
        )}
        {state.drawer === "thesis" && (
          <>
            <forms.thesis.Field name="entryType">
              {(field) => (
                <label>
                  {I.entryType}
                  <select
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    {["sentiment_correction", "trend", "special_situation"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
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
                  <label>
                    {label}
                    <textarea
                      className={input}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
                    />
                  </label>
                )}
              </forms.thesis.Field>
            ))}
            <forms.thesis.Field name="reviewed">
              {(field) => (
                <label>
                  {I.reviewed}
                  <select
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                  >
                    <option value="no">{I.no}</option>
                    <option value="yes">{I.yes}</option>
                  </select>
                </label>
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
                <label>
                  {label}
                  <textarea
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
                  />
                </label>
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
                <label>
                  {label}
                  <input
                    className={input}
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-describedby={state.error ? `${validationId} ${errorId}` : validationId}
                  />
                </label>
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
        {(state.drawer === "transactions" ||
          state.drawer === "import" ||
          state.drawer === null) && <p id={validationId} className="sr-only" />}
        {state.error && (
          <p role="alert" id={errorId}>
            {state.error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className={investmentButton}
            disabled={state.busy}
            onClick={state.close}
          >
            {I.cancel}
          </button>
          {state.drawer !== "import" && state.drawer !== "transactions" && (
            <button type="submit" className={investmentButton} disabled={state.busy}>
              {state.busy ? I.pending : I.save}
            </button>
          )}
        </div>
      </form>
    </dialog>
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
