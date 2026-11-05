// The investments drawers of the old Home (ab24ab6 modules/investments/Drawers.tsx TxnDrawer, AccountDrawer,
// ThesisDrawer, TxnsDrawer) in the shared side Drawer, same fields, order and texts. Pure: state and formatted
// rows come from useInvestmentDrawers.ts. Old classes: `.form-row` (auto-fit columns of 180px), `.field` (the
// stacked TextField / Select look, 12px bottom margin), `.fe` (12px negative), `.fhint`, `.foot`, the drawer table.
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/Drawers.strings";
import { Button, Drawer, Notice, Select, Skeleton, Tag, TextField } from "@cashu/ui";
import type {
  AccountDrawerState,
  ThesisDrawerState,
  TxnDrawerState,
  TxnsDrawerState,
} from "./useInvestmentDrawers.js";

const formRow = "grid grid-cols-[repeat(auto-fit,minmax(--spacing(45),1fr))] gap-3";
const fieldBox = "mb-3 grid gap-1";
const fe = "text-xs text-negative";
const fhint = "text-xs text-fg-muted";
const foot = "mt-2.5 text-xs-plus text-fg-muted";
const th =
  "whitespace-nowrap border-b border-border px-1 py-1.5 text-left text-xs font-strong uppercase tracking-column text-fg-muted";
const td = "border-b border-border px-1 py-1.5 text-left";
const num = "text-right tabular-nums whitespace-nowrap";
const tones = { positive: "text-positive", negative: "text-negative" } as const;

interface NumberField {
  label: string;
  value: string;
  onChange(v: string): void;
  error: string | null;
}

/** A `.field` with a typed amount and its `.fe` error line. */
function AmountField({ field }: { field: NumberField }) {
  return (
    <div className={fieldBox}>
      <TextField
        label={field.label}
        inputMode="decimal"
        value={field.value}
        onChange={field.onChange}
        invalid={field.error != null}
      />
      {field.error && <span className={fe}>{field.error}</span>}
    </div>
  );
}

export function TxnDrawerView({ state: s }: { state: TxnDrawerState }) {
  return (
    <Drawer
      title={S.addTxn}
      label={S.addTxn}
      tag={s.accountTag ? <Tag>{s.accountTag}</Tag> : undefined}
      onClose={s.onClose}
      footer={
        <>
          <span className={fhint}>{s.footHint}</span>
          <span className="flex-1" />
          <Button onPress={s.onClose}>{C.cancel}</Button>
          <Button variant="primary" disabled={s.saveDisabled} onPress={s.onSave}>
            {s.busy ? S.saving : C.save}
          </Button>
        </>
      }
    >
      {s.error && <Notice tone="negative">{s.error}</Notice>}
      <div className={formRow}>
        <Select
          label={S.account}
          value={s.account}
          options={s.accountOptions}
          onChange={s.onAccount}
          className="mb-3"
        />
        <Select
          label={S.colType}
          value={s.type}
          options={s.typeOptions}
          onChange={s.onType}
          className="mb-3"
        />
        <div className={fieldBox}>
          <TextField
            label={S.colDate}
            type="date"
            value={s.date}
            max={s.today}
            onChange={s.onDate}
            invalid={s.dateError != null}
          />
          {s.dateError && <span className={fe}>{s.dateError}</span>}
        </div>
      </div>
      {s.instrument && (
        <div className={fieldBox}>
          <Select
            label={s.instrument.label}
            value={s.instrument.value}
            options={s.instrument.options}
            onChange={s.instrument.onChange}
          />
          {s.instrument.error && <span className={fe}>{s.instrument.error}</span>}
        </div>
      )}
      {s.newInstrument && (
        <div className={formRow}>
          <TextField
            label={S.symbol}
            value={s.newInstrument.symbol}
            onChange={s.newInstrument.onSymbol}
            placeholder={S.symbolPlaceholder}
            className="mb-3"
          />
          <TextField
            label={S.isin}
            value={s.newInstrument.isin}
            onChange={s.newInstrument.onIsin}
            placeholder="IE00BK5BQT80"
            className="mb-3"
          />
          <TextField
            label={S.name}
            value={s.newInstrument.name}
            onChange={s.newInstrument.onName}
            className="mb-3"
          />
        </div>
      )}
      <div className={formRow}>
        {s.quantity && <AmountField field={s.quantity} />}
        {s.price && <AmountField field={s.price} />}
        {s.amount && <AmountField field={s.amount} />}
        {s.split && <AmountField field={s.split} />}
        {s.fee && <AmountField field={s.fee} />}
      </div>
      <div className={formRow}>
        <div className={fieldBox}>
          <Select
            label={S.txnCurrency}
            value={s.currency}
            options={s.currencyOptions}
            onChange={s.onCurrency}
          />
          {s.quotedIn && <span className={fe}>{s.quotedIn}</span>}
        </div>
        {s.fx && <AmountField field={s.fx} />}
      </div>
      <TextField label={S.note} value={s.note} onChange={s.onNote} className="mb-3" />
      <div className={foot}>{S.unsignedFoot}</div>
    </Drawer>
  );
}

export function AccountDrawerView({ state: s }: { state: AccountDrawerState }) {
  return (
    <Drawer
      title={S.addBrokerage}
      label={S.addAccount}
      onClose={s.onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button onPress={s.onClose}>{C.cancel}</Button>
          <Button variant="primary" disabled={s.busy} onPress={s.onSave}>
            {s.busy ? S.saving : C.add}
          </Button>
        </>
      }
    >
      {s.error && <Notice tone="negative">{s.error}</Notice>}
      <div className={formRow}>
        <Select
          label={S.broker}
          value={s.broker}
          options={s.brokerOptions}
          onChange={s.onBroker}
          className="mb-3"
        />
        <Select
          label={S.wrapper}
          value={s.wrapper}
          options={s.wrapperOptions}
          onChange={s.onWrapper}
          className="mb-3"
        />
        <Select
          label={S.currency}
          value={s.currency}
          options={s.currencyOptions}
          onChange={s.onCurrency}
          className="mb-3"
        />
      </div>
      <TextField
        label={S.name}
        value={s.name}
        placeholder={s.namePlaceholder}
        maxLength={60}
        onChange={s.onName}
        className="mb-3"
      />
    </Drawer>
  );
}

export function ThesisDrawerView({ state: s }: { state: ThesisDrawerState }) {
  return (
    <Drawer
      title={s.editing ? S.editThesis : S.addThesis}
      label={S.thesis}
      tag={<Tag>{s.tag}</Tag>}
      onClose={s.onClose}
      footer={
        <>
          {s.editing && (
            <label className="flex items-center gap-1.5 text-xs-plus">
              <input
                type="checkbox"
                className="size-3.75 accent-accent"
                checked={s.reviewed}
                onChange={(e) => s.onReviewed(e.target.checked)}
              />{" "}
              {S.reviewedToday}
            </label>
          )}
          <span className="flex-1" />
          <Button onPress={s.onClose}>{C.cancel}</Button>
          <Button variant="primary" disabled={s.saveDisabled} onPress={s.onSave}>
            {s.busy ? S.saving : C.save}
          </Button>
        </>
      }
    >
      {s.error && <Notice tone="negative">{s.error}</Notice>}
      <Select
        label={S.entryType}
        value={s.entry}
        options={s.entryOptions}
        onChange={s.onEntry}
        className="mb-3"
      />
      <TextField
        label={S.entry}
        multiline
        rows={3}
        placeholder={S.entryPlaceholder}
        value={s.text}
        onChange={s.onText}
        className="mb-3"
      />
      <TextField
        label={S.invalidation}
        multiline
        rows={2}
        placeholder={S.invalidationPlaceholder}
        value={s.invalidation}
        onChange={s.onInvalidation}
        className="mb-3"
      />
      <TextField
        label={S.exitPlan}
        multiline
        rows={2}
        value={s.exitPlan}
        onChange={s.onExitPlan}
        className="mb-3"
      />
      <TextField
        label={S.sizePlan}
        multiline
        rows={2}
        value={s.sizePlan}
        onChange={s.onSizePlan}
        className="mb-3"
      />
    </Drawer>
  );
}

export function TxnsDrawerView({ state: s }: { state: TxnsDrawerState }) {
  return (
    <Drawer
      title={S.txns}
      label={S.txnsLabel}
      tag={<Tag>{s.tag}</Tag>}
      width={640}
      onClose={s.onClose}
      footer={
        <>
          <span className="flex-1" />
          <Button variant="primary" onPress={s.onAdd}>
            {S.addTxn}
          </Button>
        </>
      }
    >
      {s.error && <Notice tone="negative">{s.error}</Notice>}
      {!s.rows && !s.error ? (
        <Skeleton height={120} />
      ) : (
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className={th}>{S.colDate}</th>
              <th className={th}>{S.account}</th>
              <th className={th}>{S.colType}</th>
              <th className={`${th} text-right`}>{S.colQty}</th>
              <th className={`${th} text-right`}>{S.colPrice}</th>
              <th className={`${th} text-right`}>{S.colCash}</th>
              <th className={th}>{S.colSource}</th>
            </tr>
          </thead>
          <tbody>
            {(s.rows ?? []).map((x) => (
              <tr key={x.key}>
                <td className={`${td} whitespace-nowrap`}>{x.date}</td>
                <td className={`${td} whitespace-nowrap`}>{x.account}</td>
                <td className={`${td} whitespace-nowrap`}>{x.type}</td>
                <td className={`${td} ${num}`}>{x.quantity}</td>
                <td className={`${td} ${num}`}>{x.price}</td>
                <td className={`${td} ${num} ${x.tone ? tones[x.tone] : ""}`}>{x.cash}</td>
                <td className={`${td} text-fg-muted`}>{x.source}</td>
              </tr>
            ))}
            {s.rows && !s.rows.length && (
              <tr>
                <td colSpan={7} className={`${td} text-fg-muted`}>
                  {S.noTxns}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </Drawer>
  );
}
