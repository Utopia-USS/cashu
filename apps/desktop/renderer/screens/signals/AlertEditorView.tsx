import { S as AlertS, CARD_LABEL } from "@cashu/i18n/investments/v2/Alerts.strings";
import { G } from "./Signals.strings.js";
import type { AlertEditorState } from "./useAlertEditor.js";
/** All eleven canonical kinds and their parameter descriptors use the same owner form. */
export function AlertEditorView({ state }: { state: AlertEditorState }) {
  const { form, values, data, alert, info } = state;
  const label = (name: string) =>
    name === "weight_above"
      ? G.weightAbove
      : name === "weight_below"
        ? G.weightBelow
        : name in CARD_LABEL
          ? CARD_LABEL[name as keyof typeof CARD_LABEL]
          : ((
              {
                level: AlertS.level,
                window_days: AlertS.window,
                threshold: AlertS.thresholdPct,
                direction: AlertS.direction,
                max_range_pct: AlertS.maxRange,
                multiple: AlertS.multiple,
                expression: AlertS.expression,
                bucket: G.bucket,
              } as Record<string, string>
            )[name] ?? G.code(name));
  const choiceLabel = (name: string) =>
    (
      ({
        up: AlertS.up,
        down: AlertS.down,
        above: AlertS.above,
        below: AlertS.below,
        any: G.any,
      }) as Record<string, string>
    )[name] ?? G.code(name);
  const setParam = (name: string, text: string) =>
    form.setFieldValue("params", { ...values.params, [name]: text });
  return (
    <section
      className="rounded-lg border border-border bg-surface-raised p-4"
      aria-label={alert ? G.alertsEdit : G.alertsNew}
    >
      <div className="flex items-center justify-between">
        <h2 className="text-title">{alert ? G.alertsEdit : G.alertsNew}</h2>
        <button type="button" onClick={state.onClose} aria-label={G.close}>
          {G.close}
        </button>
      </div>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <form.Field name="scope">
          {(field) => (
            <label>
              {G.scope}
              <select
                value={field.state.value}
                disabled={!!alert}
                onChange={(event) => {
                  field.handleChange(event.target.value);
                  const kinds = data.catalog.filter((entry) =>
                    entry.scopes.includes(event.target.value as never),
                  );
                  if (!kinds.some((entry) => entry.kind === values.kind) && kinds[0])
                    form.setFieldValue("kind", kinds[0].kind);
                }}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              >
                {["instrument", "portfolio", "bucket"].map((scope) => (
                  <option key={scope} value={scope}>
                    {scope === "instrument"
                      ? G.instrument
                      : scope === "portfolio"
                        ? G.portfolio
                        : G.bucket}
                  </option>
                ))}
              </select>
            </label>
          )}
        </form.Field>
        <form.Field name="kind">
          {(field) => (
            <label>
              {G.kind}
              <select
                value={field.state.value}
                disabled={!!alert}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              >
                {data.catalog
                  .filter((entry) => entry.scopes.includes(values.scope as never))
                  .map((entry) => (
                    <option key={entry.kind} value={entry.kind}>
                      {label(entry.kind)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </form.Field>
        {values.scope === "instrument" && (
          <form.Field name="instrument">
            {(field) => (
              <label>
                {G.instrument}
                <select
                  value={field.state.value}
                  disabled={!!alert}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                >
                  <option value="">-</option>
                  {data.instruments.map((instrument) => (
                    <option key={instrument.id} value={instrument.id}>
                      {instrument.symbol ?? instrument.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </form.Field>
        )}
        {(info?.params ?? [])
          .filter((param) => param.name !== "bucket" || values.scope === "bucket")
          .map((param) => (
            <label key={param.name} htmlFor={`signals-alert-${param.name}`}>
              {label(param.name)}
              {param.name === "bucket" && data.context.status === "ready" ? (
                <select
                  id={`signals-alert-${param.name}`}
                  value={values.params[param.name] ?? ""}
                  onChange={(event) => setParam(param.name, event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                >
                  <option value="">-</option>
                  {data.context.allocation.buckets.map((bucket) => (
                    <option key={bucket.bucket_id} value={bucket.bucket_id}>
                      {bucket.bucket_id}
                    </option>
                  ))}
                </select>
              ) : param.type === "choice" ? (
                <select
                  id={`signals-alert-${param.name}`}
                  value={values.params[param.name] ?? ""}
                  onChange={(event) => setParam(param.name, event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                >
                  {param.choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choiceLabel(choice)}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`signals-alert-${param.name}`}
                  value={values.params[param.name] ?? ""}
                  onChange={(event) => setParam(param.name, event.target.value)}
                  inputMode={param.type === "text" ? "text" : "decimal"}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              )}
            </label>
          ))}
        <form.Field name="title">
          {(field) => (
            <label>
              {G.titleField}
              <input
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              />
            </label>
          )}
        </form.Field>
        <form.Field name="tag">
          {(field) => (
            <label>
              {G.alertTag}
              <input
                value={field.state.value}
                maxLength={24}
                list="signals-alert-tags"
                onChange={(event) => field.handleChange(event.target.value)}
                aria-describedby="signals-alert-tag-hint"
                className="block w-full rounded-sm border border-border bg-surface p-2"
              />
              <span id="signals-alert-tag-hint" className="block text-caption text-fg-muted">
                {G.alertTagHint}
              </span>
              <datalist id="signals-alert-tags">
                {[
                  ...new Set(
                    data.alerts.map((row) => row.tag).filter((tag): tag is string => !!tag),
                  ),
                ]
                  .sort()
                  .map((tag) => (
                    <option key={tag} value={tag} />
                  ))}
              </datalist>
            </label>
          )}
        </form.Field>
        <form.Field name="note">
          {(field) => (
            <label>
              {G.note}
              <textarea
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
                className="block w-full rounded-sm border border-border bg-surface p-2"
              />
            </label>
          )}
        </form.Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <form.Field name="polarity">
            {(field) => (
              <label>
                {G.polarity}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                >
                  <option value="positive">{G.positive}</option>
                  <option value="negative">{G.negative}</option>
                  <option value="neutral">{G.neutral}</option>
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="severity">
            {(field) => (
              <label>
                {G.severity}
                <select
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                >
                  <option value="info">{G.info}</option>
                  <option value="action">{G.urgent}</option>
                </select>
              </label>
            )}
          </form.Field>
          <form.Field name="cooldown">
            {(field) => (
              <label>
                {G.cooldown}
                <input
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  inputMode="numeric"
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </form.Field>
          <form.Field name="expiry">
            {(field) => (
              <label>
                {G.expiry}
                <input
                  type="date"
                  value={field.state.value}
                  onChange={(event) => field.handleChange(event.target.value)}
                  className="block w-full rounded-sm border border-border bg-surface p-2"
                />
              </label>
            )}
          </form.Field>
        </div>
        {state.error && <p role="alert">{String(state.error)}</p>}
        <div className="flex gap-2">
          <button
            type="submit"
            disabled={state.busy}
            className="rounded-sm bg-accent px-3 py-2 text-on-accent"
          >
            {G.save}
          </button>
          <button type="button" onClick={state.onClose}>
            {G.cancel}
          </button>
        </div>
      </form>
    </section>
  );
}
