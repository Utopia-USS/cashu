import { Amount, Button, DateText, Modal, Money, Percent } from "@cashu/ui";
import { field } from "./controls.js";
import { G } from "./Signals.strings.js";
import type { DecisionDialogState } from "./useDecisionDialog.js";

/** Record a decision for one signal group: context, suggestion, estimate and the form. */
export function DecisionDialogView({
  open,
  title,
  context,
  more,
  form,
  suggestedQuantity,
  quantityUnavailable,
  estimate,
  thesis,
  accounts,
  nextDeposit,
  busy,
  onClose,
}: DecisionDialogState) {
  if (!open) return null;
  return (
    <Modal label={G.decide} onClose={onClose} className="mx-auto max-w-xl p-5">
      <header className="flex items-center justify-between">
        <h2>
          {G.decide}: {title}
        </h2>
        <Button onPress={onClose}>{G.close}</Button>
      </header>
      <div className="py-3">
        <h3>{G.context}</h3>
        {context.map((row) => (
          <p key={row.gid}>
            {row.message} <DateText value={row.day} />
          </p>
        ))}
        {more > 0 && <p>{G.more(more)}</p>}
        {thesis && (
          <p>
            {G.thesis}: {thesis.thesis}
            {thesis.exitPlan && (
              <>
                {" "}
                · {G.exitPlan}: {thesis.exitPlan}
              </>
            )}
          </p>
        )}
        {nextDeposit && (
          <p>
            {G.nextDeposit}: <DateText value={nextDeposit} />
          </p>
        )}
        {suggestedQuantity && (
          <p>
            {G.suggestedQuantity}: <Amount value={suggestedQuantity} fractionDigits={0} />
          </p>
        )}
        {quantityUnavailable && <p>{G.quantityUnavailable}</p>}
        {estimate && (
          <p>
            {G.estimate}: <Money value={estimate.value} />
            {estimate.allocation && (
              <>
                {" "}
                · {G.afterWeight}: <Percent value={estimate.allocation.afterWeight} /> ·{" "}
                {G.targetWeight}: <Percent value={estimate.allocation.target} /> · {G.drift}:{" "}
                <Amount value={estimate.allocation.driftPp} fractionDigits={1} /> {G.pp}
              </>
            )}
          </p>
        )}
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="action">
          {(input) => (
            <label>
              {G.action}
              <select
                value={input.state.value}
                onChange={(event) => input.handleChange(event.target.value)}
                className={field}
              >
                <option value="held">{G.held}</option>
                <option value="bought">{G.buy}</option>
                <option value="sold">{G.sell}</option>
                <option value="other">{G.later}</option>
              </select>
            </label>
          )}
        </form.Field>
        <form.Field name="account">
          {(input) => (
            <label>
              {G.account}
              <select
                value={input.state.value}
                onChange={(event) => input.handleChange(event.target.value)}
                className={field}
              >
                <option value="">-</option>
                {accounts.map((account) => (
                  <option key={account.gid} value={account.gid}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form.Field>
        <div className="grid grid-cols-3 gap-2">
          <form.Field name="quantity">
            {(input) => (
              <label>
                {G.quantity}
                <input
                  value={input.state.value}
                  onChange={(event) => input.handleChange(event.target.value)}
                  inputMode="decimal"
                  className={field}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="price">
            {(input) => (
              <label>
                {G.price}
                <input
                  value={input.state.value}
                  onChange={(event) => input.handleChange(event.target.value)}
                  inputMode="decimal"
                  className={field}
                />
              </label>
            )}
          </form.Field>
          <form.Field name="currency">
            {(input) => (
              <label>
                {G.currency}
                <input
                  value={input.state.value}
                  onChange={(event) => input.handleChange(event.target.value)}
                  className={field}
                />
              </label>
            )}
          </form.Field>
        </div>
        <form.Field name="reason">
          {(input) => (
            <label>
              {G.reason}
              <textarea
                value={input.state.value}
                onChange={(event) => input.handleChange(event.target.value)}
                className={field}
              />
            </label>
          )}
        </form.Field>
        <p>{G.noTrade}</p>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy}>
            {G.save}
          </Button>
          <Button onPress={onClose}>{G.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}
