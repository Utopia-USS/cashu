import { Money as MoneyValue } from "@cashu/domain";
import { S as A } from "@cashu/i18n/assets/AssetsWidget.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { Modal, Money } from "@cashu/ui";
import { useEffect, useState } from "react";
import type { AssetDrawerState } from "./useAssetDrawer.js";

export interface AssetsWidgetViewProps {
  state: AssetDrawerState;
  today: string;
  baseCurrency: string;
  privacy: boolean;
}

/** Manual positions and their native edit drawer. Financial values remain Decimals in the View. */
export function AssetsWidgetView({ state, today, baseCurrency, privacy }: AssetsWidgetViewProps) {
  const [all, setAll] = useState(false);
  const shown = all ? state.displayRows : state.displayRows.slice(0, 5);
  return (
    <section
      className="rounded-lg border border-border bg-surface-raised p-6"
      aria-labelledby="overview-assets-title"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 id="overview-assets-title" className="text-title font-strong">
          {A.title} {state.rows.length > 0 && `(${state.rows.length})`}
        </h2>
        <button type="button" onClick={() => state.openNew("property", baseCurrency)}>
          {A.addPlus}
        </button>
      </div>
      {state.rows.length === 0 ? (
        <div>
          <p className="text-fg-muted">{A.empty}</p>
          <button type="button" onClick={() => state.openNew("vehicle", baseCurrency)}>
            {state.vehicleLabel}
          </button>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((row) => (
            <li key={row.gid} className="flex items-center justify-between gap-3 py-3">
              <div>
                <button
                  type="button"
                  onClick={() => state.openEdit(row.gid)}
                  aria-label={A.editOf(privacy ? A.title : row.name)}
                  className="font-strong"
                >
                  {privacy ? "•••" : row.name}
                </button>
                {!privacy && row.note && (
                  <span
                    className="ml-2 rounded-sm bg-surface-sunken px-1 text-caption"
                    title={row.note}
                  >
                    {A.note}
                  </span>
                )}
                {row.valuation && (
                  <p
                    className={`text-caption ${row.valuation.stale ? "text-warning" : "text-fg-muted"}`}
                    title={row.valuation.stale ? A.staleTitle : undefined}
                  >
                    {row.valuation.text}
                  </p>
                )}
              </div>
              <div className="text-right">
                <Money
                  value={row.amount === null ? null : new MoneyValue(row.amount, row.currency)}
                />
                {row.lossLine && <p className="text-caption text-fg-muted">{row.lossLine}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-4 flex flex-wrap justify-between gap-3 border-t border-border pt-3 text-caption">
        <span>
          {A.total}{" "}
          {state.orderedTotals.map(([currency, amount]) => (
            <Money key={currency} value={new MoneyValue(amount, currency)} />
          ))}
        </span>
        {state.lossSummary && (
          <span>
            {A.cars(state.lossSummary.count)} -{state.lossSummary.text}
            {A.perMonth}
          </span>
        )}
        {state.rows.length > 5 && (
          <button type="button" onClick={() => setAll(!all)}>
            {all ? A.less : A.all(state.rows.length)}
          </button>
        )}
        {state.undone !== null && (
          <button type="button" onClick={() => void state.undo()}>
            {C.undo}
          </button>
        )}
      </div>
      <AssetDrawerView state={state} today={today} privacy={privacy} />
    </section>
  );
}

/** Shared native asset dialog used by Overview and assets first steps. */
export function AssetDrawerView({
  state,
  today,
  privacy,
}: Pick<AssetsWidgetViewProps, "state" | "today" | "privacy">) {
  useEffect(() => {
    if (privacy && state.open) state.close();
  }, [state, privacy]);
  const target = state.target;
  const form = state.form;
  const vehicle = target?.kind === "vehicle" || (target === null && form.type === "vehicle");
  return (
    <>
      {state.open && !privacy && (
        <Modal
          label={target === null ? A.newPosition : A.editOf(target.name)}
          onClose={state.close}
          placement="center"
          width="sm"
          closeOnBackdrop={false}
        >
          <h3 className="text-headline font-strong">
            {target === null ? A.newPosition : A.editOf(privacy ? A.title : target.name)}
          </h3>
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              void state.submit();
            }}
          >
            {target === null && (
              <>
                <label className="flex flex-col gap-1">
                  {A.name}
                  <input
                    value={form.name}
                    onChange={(event) => state.set("name", event.target.value)}
                    autoComplete="off"
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {A.type}
                  <select
                    value={form.type}
                    onChange={(event) => state.set("type", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  >
                    {state.positionTypes.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  {A.currency}
                  <input
                    value={form.currency}
                    maxLength={3}
                    onChange={(event) => state.set("currency", event.target.value.toUpperCase())}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
              </>
            )}
            {vehicle ? (
              <>
                <label className="flex flex-col gap-1">
                  {A.purchasePrice}
                  <input
                    inputMode="decimal"
                    value={form.purchasePrice}
                    onChange={(event) => state.set("purchasePrice", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {A.purchaseDate}
                  <input
                    type="date"
                    max={today}
                    value={form.purchaseDate}
                    onChange={(event) => state.set("purchaseDate", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {A.yearlyDecline}
                  <input
                    inputMode="decimal"
                    value={form.annualRate}
                    onChange={(event) => state.set("annualRate", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {A.floor}
                  <input
                    inputMode="decimal"
                    value={form.floor}
                    onChange={(event) => state.set("floor", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                {state.preview && (
                  <p className="text-caption text-fg-muted sm:col-span-2">{state.preview}</p>
                )}
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  {A.value}
                  <input
                    inputMode="decimal"
                    value={form.value}
                    onChange={(event) => state.set("value", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  {A.valuationDate}
                  <input
                    type="date"
                    max={today}
                    value={form.onDate}
                    onChange={(event) => state.set("onDate", event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
              </>
            )}
            <label className="flex flex-col gap-1 sm:col-span-2">
              {A.noteLabel}
              <textarea
                value={form.note}
                maxLength={500}
                onChange={(event) => state.set("note", event.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              />
            </label>
            {state.error !== null && (
              <p role="alert" className="text-negative sm:col-span-2">
                {state.error}
              </p>
            )}
            <div className="flex justify-between gap-3 sm:col-span-2">
              {target !== null && (
                <button type="button" disabled={state.busy} onClick={() => void state.remove()}>
                  {C.remove}
                </button>
              )}
              <span className="flex gap-2">
                <button type="button" onClick={state.close}>
                  {C.cancel}
                </button>
                <button type="submit" disabled={state.busy}>
                  {state.busy ? A.saving : C.save}
                </button>
              </span>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
