// Majątek on Przegląd (ab24ab6 modules/assets/AssetsWidget.tsx): the manually valued positions (valuation date
// or a vehicle's curve, monthly loss), `+ Dodaj`, the footer totals and `wszystkie (n)`; with no position the
// widget is the module's first steps. The add / edit drawer (AssetDrawer) is shared with the Majątek page.
import { S as A } from "@cashu/i18n/assets/AssetsWidget.strings";
import { C } from "@cashu/i18n/core/common.strings";
import {
  Button,
  Drawer,
  FormRow,
  Notice,
  rowLinkCls,
  Select,
  Tag,
  TextField,
  Widget,
} from "@cashu/ui";
import { useState } from "react";
import { AssetsStepsView } from "../assets/AssetsStepsView.js";
import { tileNum, tileTable, tileTd } from "./OverviewWidgetsView.js";
import type { AssetDrawerState } from "./useAssetDrawer.js";

const sym = "block -mt-px text-2xs-plus text-fg-muted";
const nameBtn =
  "cursor-pointer border-0 bg-transparent p-0 text-left font-strong text-fg [font:inherit] hover:text-accent";
const CAP = 5;
/** The placeholder of a money field an incognito edit leaves empty (useAssetDrawer `masked`). */
const MASK = "•••";

export interface AssetsWidgetViewProps {
  state: AssetDrawerState;
  today: string;
  baseCurrency: string;
  /** The Majątek page (old `Instrukcja Claude Code i CLI` link of the first steps). */
  onSetup(): void;
}

export function AssetsWidgetView({ state, today, baseCurrency, onSetup }: AssetsWidgetViewProps) {
  const [all, setAll] = useState(false);
  const rows = state.widgetRows;
  const drawer = <AssetDrawerView state={state} today={today} />;
  const add = (type: string) => state.openNew(type, baseCurrency);
  if (!rows.length)
    return (
      <Widget
        title={A.title}
        variant="quiet"
        layered
        tight
        id="ov-assets"
        footer={
          <Button variant="link" size="sm" onPress={onSetup}>
            {A.setupLink}
          </Button>
        }
      >
        <AssetsStepsView compact model={state.steps} onAdd={add} />
        {drawer}
      </Widget>
    );
  const shown = all ? rows : rows.slice(0, CAP);
  return (
    <Widget
      title={A.title}
      count={rows.length}
      variant="quiet"
      layered
      id="ov-assets"
      controls={
        <Button size="sm" onPress={() => add("property")}>
          {A.addPlus}
        </Button>
      }
      tight
      footer={
        <>
          <span>
            {A.total} <b>{state.totalsText}</b>
          </span>
          {state.lossSummary && (
            <span>
              {A.cars(state.lossSummary.count)} <b>-{state.lossSummary.text}</b>
              {A.perMonth}
            </span>
          )}
          <span className="flex-1" />
          {state.undone !== null && (
            <Button variant="link" size="sm" onPress={state.undo}>
              {C.undo}
            </Button>
          )}
          {rows.length > CAP && (
            <Button variant="link" size="sm" onPress={() => setAll(!all)}>
              {all ? A.less : A.all(rows.length)}
            </Button>
          )}
        </>
      }
    >
      <table className={tileTable}>
        <tbody>
          {shown.map((row) => (
            <tr key={row.gid} className={rowLinkCls} onClick={() => state.openEdit(row.gid)}>
              <td className={tileTd}>
                <button
                  type="button"
                  className={nameBtn}
                  aria-label={A.editOf(row.name)}
                  onClick={(event) => {
                    event.stopPropagation();
                    state.openEdit(row.gid);
                  }}
                >
                  {row.name}
                </button>
                {row.note && (
                  <>
                    {" "}
                    <Tag title={row.note}>{A.note}</Tag>
                  </>
                )}
                {row.sub && (
                  <span
                    className={`${sym} ${row.sub.stale ? "text-warning" : ""}`}
                    title={row.sub.stale ? A.staleTitle : undefined}
                  >
                    {row.sub.text}
                  </span>
                )}
              </td>
              <td className={`${tileNum} font-heavy`}>
                {row.value}
                {row.lossLine && <span className={`${sym} font-regular`}>{row.lossLine}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {drawer}
    </Widget>
  );
}

const sub = "-mt-1.5 mb-3 text-2xs-plus text-fg-muted";

/** The add / edit form in a drawer (old AssetDrawer, 480px): a new position (name, type, value, currency, date,
 * note; a vehicle: its curve instead), a manual row (value, date, note) or a vehicle (read-only value, its curve,
 * note). Shared by Przegląd and the Majątek page; an edit opened in incognito leaves its money fields empty. */
export function AssetDrawerView({ state, today }: Pick<AssetsWidgetViewProps, "state" | "today">) {
  if (!state.open) return null;
  const target = state.target;
  const form = state.form;
  const vehicle = target?.kind === "vehicle";
  const newVehicle = target === null && form.type === "vehicle";
  const t = state.drawerText;
  const field = "mb-3";
  const value = (
    <TextField
      label={A.value}
      inputMode="decimal"
      autoComplete="off"
      value={form.value}
      placeholder={state.masked ? MASK : undefined}
      onChange={(v) => state.set("value", v)}
      className={field}
    />
  );
  const date = (
    <TextField
      label={A.valuationDate}
      type="date"
      max={today}
      value={form.onDate}
      onChange={(v) => state.set("onDate", v)}
      className={field}
    />
  );
  const currency = (
    <TextField
      label={A.currency}
      maxLength={3}
      autoComplete="off"
      value={form.currency}
      onChange={(v) => state.set("currency", v.toUpperCase())}
      className={field}
    />
  );
  const price = (
    <TextField
      label={A.purchasePrice}
      inputMode="decimal"
      autoComplete="off"
      value={form.purchasePrice}
      placeholder={state.masked ? MASK : undefined}
      onChange={(v) => state.set("purchasePrice", v)}
      className={field}
    />
  );
  const curve = (
    <>
      {target === null ? (
        <FormRow>
          {price}
          {currency}
        </FormRow>
      ) : (
        price
      )}
      <FormRow>
        <TextField
          label={A.purchaseDate}
          type="date"
          max={today}
          value={form.purchaseDate}
          onChange={(v) => state.set("purchaseDate", v)}
          className={field}
        />
        <TextField
          label={A.yearlyDecline}
          inputMode="decimal"
          autoComplete="off"
          value={form.annualRate}
          onChange={(v) => state.set("annualRate", v)}
          className={field}
        />
      </FormRow>
      <TextField
        label={A.floor}
        inputMode="decimal"
        autoComplete="off"
        value={form.floor}
        placeholder={state.masked ? MASK : undefined}
        onChange={(v) => state.set("floor", v)}
        className={field}
      />
      {state.preview && <div className={sub}>{state.preview}</div>}
    </>
  );
  const note = (
    <TextField
      label={A.noteLabel}
      maxLength={500}
      autoComplete="off"
      value={form.note}
      onChange={(v) => state.set("note", v)}
      className={field}
    />
  );
  return (
    <Drawer
      width={480}
      label={A.title}
      title={t.title}
      tag={t.tag ? <Tag>{t.tag}</Tag> : undefined}
      onClose={state.close}
      footer={
        <>
          <Button
            variant="primary"
            disabled={state.busy}
            pending={state.saving}
            onPress={state.submit}
          >
            {C.save}
          </Button>
          <Button onPress={state.close}>{C.cancel}</Button>
          {target !== null && (
            <Button disabled={state.busy} onPress={state.remove}>
              {C.remove}
            </Button>
          )}
        </>
      }
    >
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void state.submit();
        }}
      >
        {state.error !== null && <Notice tone="negative">{state.error}</Notice>}
        {target === null ? (
          <>
            <TextField
              label={A.name}
              maxLength={120}
              autoComplete="off"
              value={form.name}
              onChange={(v) => state.set("name", v)}
              className={field}
            />
            <Select
              label={A.type}
              value={form.type}
              onChange={(v) => state.set("type", v)}
              options={state.positionTypes}
              className={field}
            />
            {newVehicle ? (
              curve
            ) : (
              <>
                <FormRow>
                  {value}
                  {currency}
                </FormRow>
                {date}
              </>
            )}
            {note}
          </>
        ) : vehicle ? (
          <>
            <div className={`${field} grid gap-1`}>
              <span className="text-xs text-fg-muted">{A.value}</span>
              <output className="py-0.5 text-md font-strong tabular-nums">{t.readOnlyValue}</output>
            </div>
            {curve}
            {note}
          </>
        ) : (
          <>
            <FormRow>
              {value}
              {date}
            </FormRow>
            {t.lastValuation && <div className={sub}>{t.lastValuation}</div>}
            {note}
          </>
        )}
      </form>
    </Drawer>
  );
}
