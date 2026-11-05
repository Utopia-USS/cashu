import { Money as MoneyValue } from "@cashu/domain";
import { S as A } from "@cashu/i18n/assets/AssetsWidget.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { Button, Modal, Money, Select, TextField } from "@cashu/ui";
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
                <TextField
                  label={A.name}
                  value={form.name}
                  onChange={(value) => state.set("name", value)}
                  autoComplete="off"
                />
                <Select
                  label={A.type}
                  value={form.type}
                  onChange={(value) => state.set("type", value)}
                  options={state.positionTypes}
                />
                <TextField
                  label={A.currency}
                  value={form.currency}
                  maxLength={3}
                  onChange={(value) => state.set("currency", value.toUpperCase())}
                />
              </>
            )}
            {vehicle ? (
              <>
                <TextField
                  label={A.purchasePrice}
                  inputMode="decimal"
                  value={form.purchasePrice}
                  onChange={(value) => state.set("purchasePrice", value)}
                />
                <TextField
                  label={A.purchaseDate}
                  type="date"
                  max={today}
                  value={form.purchaseDate}
                  onChange={(value) => state.set("purchaseDate", value)}
                />
                <TextField
                  label={A.yearlyDecline}
                  inputMode="decimal"
                  value={form.annualRate}
                  onChange={(value) => state.set("annualRate", value)}
                />
                <TextField
                  label={A.floor}
                  inputMode="decimal"
                  value={form.floor}
                  onChange={(value) => state.set("floor", value)}
                />
                {state.preview && (
                  <p className="text-caption text-fg-muted sm:col-span-2">{state.preview}</p>
                )}
              </>
            ) : (
              <>
                <TextField
                  label={A.value}
                  inputMode="decimal"
                  value={form.value}
                  onChange={(value) => state.set("value", value)}
                />
                <TextField
                  label={A.valuationDate}
                  type="date"
                  max={today}
                  value={form.onDate}
                  onChange={(value) => state.set("onDate", value)}
                />
              </>
            )}
            <TextField
              label={A.noteLabel}
              multiline
              value={form.note}
              maxLength={500}
              onChange={(value) => state.set("note", value)}
              className="sm:col-span-2"
            />
            {state.error !== null && (
              <p role="alert" className="text-negative sm:col-span-2">
                {state.error}
              </p>
            )}
            <div className="flex justify-between gap-3 sm:col-span-2">
              {target !== null && (
                <Button variant="danger" disabled={state.busy} onPress={() => void state.remove()}>
                  {C.remove}
                </Button>
              )}
              <span className="flex gap-2">
                <Button onPress={state.close}>{C.cancel}</Button>
                <Button variant="primary" type="submit" disabled={state.busy}>
                  {state.busy ? A.saving : C.save}
                </Button>
              </span>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
