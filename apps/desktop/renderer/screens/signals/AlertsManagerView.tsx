// The ported alerts manager page (ab24ab6 v2/Alerts.tsx AlertsManager + AlertForm + TriggeredHistory; index.css
// `.crumb`, `.pagehead`, `.w table`, `.cond`, `.acts`, `.w .form`, `.frow`, `.kinds`, `.kind`, `.preview`): the
// status and source filters, the table, the form (new or edited) and the 12-month triggered history. Pure.

import { S as W } from "@cashu/i18n/core/widgets.strings";
import {
  AgentTag,
  AlertIcon,
  AlertStatus,
  Button,
  Crumb,
  emptyCls,
  Grid,
  Notice,
  PageHead,
  PolarityText,
  Seg,
  Skeleton,
  tableCls,
  tdCls,
  thCls,
  Widget,
} from "@cashu/ui";
import type { ReactNode } from "react";
import type {
  AlertTableRow,
  HistoryRow,
  KindCard,
  Scope,
  SourceFilter,
  StatusFilter,
} from "./alertsModel.js";
import { inputCls, selectCls, textareaCls } from "./fields.js";
import type { Press } from "./signalsDialogModel.js";

interface SegField<T extends string> {
  label: string;
  /** The group's accessible name when it differs from the visible label. */
  ariaLabel?: string;
  items: [string, T][];
  value: T;
  onChange(v: T): void;
  disabled?: boolean;
  title?: string;
}
interface TextInput {
  id: string;
  label: string;
  value: string;
  onChange(v: string): void;
  num?: boolean;
  inputMode?: "decimal" | "numeric";
  disabled?: boolean;
  placeholder?: string;
  maxLength?: number;
}
interface Choice {
  id: string;
  label: string;
  value: string;
  onChange(v: string): void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}

export interface AlertFormProps {
  heading: string;
  agent: string | null;
  close: Press | null;
  scope: SegField<Scope> & { fieldTitle?: string };
  instrument: (TextInput & { list: string[]; listId: string; watchFirst: string | null }) | null;
  bucket: Choice | null;
  cards: {
    label: string;
    items: {
      card: KindCard;
      label: string;
      machine: string;
      on: boolean;
      disabled: boolean;
      onPress(): void;
    }[];
  };
  /** Rows of fields between the kind cards and the type / severity row, in the old order. */
  rows: ({ kind: "pair"; cells: FieldCell[] } | { kind: "one"; cell: FieldCell })[];
  polarity: SegField<string>;
  severity: SegField<string>;
  title: TextInput;
  note: TextInput & { rows: number };
  cooldown: Choice;
  expiry: Choice;
  preview: string | null;
  error: string | null;
  save: Press;
  cancel: Press | null;
  noForecasts: string;
  onEscape: (() => void) | null;
}
export type FieldCell =
  | { kind: "input"; field: TextInput }
  | { kind: "seg"; field: SegField<string> }
  | { kind: "textarea"; field: TextInput & { rows: number } };

export interface AlertsManagerProps {
  crumb: { label: string; items: { label: string; onPress?: () => void }[] };
  title: string;
  status: SegField<StatusFilter>;
  source: SegField<SourceFilter>;
  checked: string;
  list: {
    label: string;
    loading: boolean;
    empty: string | null;
    head: {
      status: string;
      alert: string;
      scope: string;
      nowLevel: string;
      type: string;
      source: string;
      last: string;
      actions: string;
    };
    rows: (AlertTableRow & {
      you: string;
      agentText: string;
      mute: Press & { glyph: string };
      edit: Press;
      remove: Press;
    })[];
    foot: { count: string; word: string; limit: string; limitValue: string };
  };
  form: ReactNode;
  history: {
    title: string;
    count: string;
    loading: boolean;
    empty: string | null;
    exportCsv: Press | null;
    head: string[];
    you: string;
    agent: string;
    deleted: string;
    rows: HistoryRow[];
  };
}

const fieldCls = "grid gap-1 [&>label]:text-2xs-plus [&>label]:text-fg-muted";
const condCls = "block text-xs text-fg-muted";
const iconBtn =
  "cursor-pointer border-0 bg-transparent px-1.5 py-0.5 font-control text-xs leading-control text-fg-muted disabled:cursor-default disabled:opacity-60";

function SegCell({ f }: { f: SegField<string> }) {
  return (
    <Seg
      quiet
      label={f.ariaLabel ?? f.label}
      items={f.items}
      value={f.value}
      onChange={f.onChange}
      disabled={f.disabled}
      title={f.title}
      className="flex [&>button]:flex-1"
    />
  );
}

function Cell({ c }: { c: FieldCell }) {
  if (c.kind === "seg")
    return (
      <div className={fieldCls}>
        <span className="text-2xs-plus text-fg-muted">{c.field.label}</span>
        <SegCell f={c.field} />
      </div>
    );
  const f = c.field;
  return (
    <div className={fieldCls}>
      <label htmlFor={f.id}>{f.label}</label>
      {c.kind === "textarea" ? (
        <textarea
          id={f.id}
          rows={c.field.rows}
          value={f.value}
          onChange={(e) => f.onChange(e.target.value)}
          placeholder={f.placeholder}
          className={textareaCls()}
        />
      ) : (
        <input
          id={f.id}
          value={f.value}
          inputMode={f.inputMode}
          disabled={f.disabled}
          onChange={(e) => f.onChange(e.target.value)}
          className={inputCls({ num: f.num, field: true })}
        />
      )}
    </div>
  );
}

function ChoiceField({ c }: { c: Choice }) {
  return (
    <div className={fieldCls}>
      <label htmlFor={c.id}>{c.label}</label>
      <select
        id={c.id}
        value={c.value}
        disabled={c.disabled}
        onChange={(e) => c.onChange(e.target.value)}
        className={selectCls({ field: true })}
      >
        {c.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/** Old AlertForm (`section.w.hl` with `.wb.tight.form`). */
export function AlertFormView(p: AlertFormProps) {
  return (
    <Widget
      title={p.heading}
      highlight
      tight
      tags={p.agent ? <AgentTag full text={p.agent} title={W.addedByAgent} /> : undefined}
      controls={
        p.close ? (
          <button
            type="button"
            aria-label={p.close.label}
            title={p.close.title}
            onClick={p.close.onPress}
            className={`${iconBtn} text-base hover:text-fg`}
          >
            {"✕"}
          </button>
        ) : undefined
      }
    >
      <form
        className="grid gap-3"
        onSubmit={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key === "Escape" && p.onEscape) {
            e.stopPropagation();
            p.onEscape();
          }
        }}
      >
        <div className={fieldCls} title={p.scope.fieldTitle}>
          <span className="text-2xs-plus text-fg-muted">{p.scope.label}</span>
          <SegCell f={p.scope as SegField<string>} />
        </div>
        {p.instrument && (
          <div className={fieldCls}>
            <label htmlFor={p.instrument.id}>{p.instrument.label}</label>
            <input
              id={p.instrument.id}
              list={p.instrument.listId}
              value={p.instrument.value}
              onChange={(e) => p.instrument?.onChange(e.target.value)}
              disabled={p.instrument.disabled}
              placeholder={p.instrument.placeholder}
              autoComplete="off"
              className={inputCls({ field: true })}
            />
            <datalist id={p.instrument.listId}>
              {p.instrument.list.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
            {p.instrument.watchFirst && (
              <span className="text-2xs-plus text-fg-muted">{p.instrument.watchFirst}</span>
            )}
          </div>
        )}
        {p.bucket && <ChoiceField c={p.bucket} />}
        <div className={fieldCls}>
          <span className="text-2xs-plus text-fg-muted">{p.cards.label}</span>
          <fieldset
            aria-label={p.cards.label}
            className="m-0 grid min-w-0 grid-cols-2 gap-1.5 border-0 p-0 max-narrow:grid-cols-1"
          >
            {p.cards.items.map((c) => (
              <label
                key={c.card}
                className={`cursor-pointer rounded-control border bg-surface-raised px-2.25 py-1.75 text-left text-xs-plus text-fg has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus has-disabled:cursor-default has-disabled:opacity-50 ${c.on ? "border-accent ring-1 ring-accent ring-inset" : "border-border"}`}
              >
                <input
                  type="radio"
                  name="af-kind"
                  checked={c.on}
                  disabled={c.disabled}
                  onChange={c.onPress}
                  className="sr-only"
                />
                {c.label}
                <span className="block text-2xs text-fg-muted">{c.machine}</span>
              </label>
            ))}
          </fieldset>
        </div>
        {p.rows.map((r) =>
          r.kind === "pair" ? (
            <div
              key={r.cells.map((c) => c.field.label).join("|")}
              className="grid grid-cols-2 gap-3 max-narrow:grid-cols-1"
            >
              {r.cells.map((c) => (
                <Cell key={c.field.label} c={c} />
              ))}
            </div>
          ) : (
            <Cell key={r.cell.field.label} c={r.cell} />
          ),
        )}
        <div className="grid grid-cols-2 gap-3 max-narrow:grid-cols-1">
          <div className={fieldCls}>
            <span className="text-2xs-plus text-fg-muted">{p.polarity.label}</span>
            <SegCell f={p.polarity} />
          </div>
          <div className={fieldCls}>
            <span className="text-2xs-plus text-fg-muted">{p.severity.label}</span>
            <SegCell f={p.severity} />
          </div>
        </div>
        <div className={fieldCls}>
          <label htmlFor={p.title.id}>{p.title.label}</label>
          <input
            id={p.title.id}
            value={p.title.value}
            maxLength={p.title.maxLength}
            onChange={(e) => p.title.onChange(e.target.value)}
            className={inputCls({ field: true })}
          />
        </div>
        <div className={fieldCls}>
          <label htmlFor={p.note.id}>{p.note.label}</label>
          <textarea
            id={p.note.id}
            rows={p.note.rows}
            value={p.note.value}
            maxLength={p.note.maxLength}
            onChange={(e) => p.note.onChange(e.target.value)}
            placeholder={p.note.placeholder}
            className={textareaCls()}
          />
        </div>
        <div className="grid grid-cols-2 gap-3 max-narrow:grid-cols-1">
          <ChoiceField c={p.cooldown} />
          <ChoiceField c={p.expiry} />
        </div>
        {p.preview && (
          <div aria-live="polite" className="rounded-control bg-chip px-3 py-2 text-xs-plus">
            {p.preview}
          </div>
        )}
        {p.error && <Notice tone="negative">{p.error}</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" onPress={p.save.onPress} disabled={p.save.disabled}>
            {p.save.label}
          </Button>
          {p.cancel && <Button onPress={p.cancel.onPress}>{p.cancel.label}</Button>}
          <span className="flex-1" />
          <span className="text-2xs-plus text-fg-muted">{p.noForecasts}</span>
        </div>
      </form>
    </Widget>
  );
}

function Table({ p }: { p: AlertsManagerProps["list"] }) {
  const h = p.head;
  return (
    <div className="overflow-x-auto">
      {/* old `.wb > .scroll:first-child table { margin-top: -2px }` */}
      <table className={`${tableCls(true)} -mt-0.5`}>
        <thead>
          <tr>
            <th className={thCls()}>{h.status}</th>
            <th className={thCls()}>{h.alert}</th>
            <th className={thCls()}>{h.scope}</th>
            <th className={thCls(true)}>{h.nowLevel}</th>
            <th className={thCls()}>{h.type}</th>
            <th className={thCls()}>{h.source}</th>
            <th className={thCls()}>{h.last}</th>
            <th className={thCls()}>
              <span className="sr-only">{h.actions}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {p.rows.map((r) => (
            <tr key={r.id}>
              <td className={tdCls()}>
                {r.glyph.kind === "icon" ? (
                  <AlertIcon state={r.glyph.state} title={r.glyph.title} className="mr-1.5" />
                ) : (
                  <AlertStatus status={r.glyph.status} />
                )}
              </td>
              <td className={tdCls()}>
                <span className="font-strong">{r.name}</span>
                <span className={condCls}>{r.cond}</span>
              </td>
              <td className={tdCls()}>
                {r.scope.kind === "text" ? (
                  r.scope.text
                ) : (
                  // old InstLabel inline in a table cell (`.il.inl`, `.nmt`, `.sym`): a centred flex row
                  <span className="flex items-center">
                    <span className="block">{r.scope.name}</span>
                    {r.scope.sym && (
                      <span className="ml-1.25 block text-2xs-plus text-fg-muted">
                        {r.scope.sym}
                      </span>
                    )}
                  </span>
                )}
              </td>
              <td className={tdCls(true)}>
                <b>{r.now}</b>
                <span className={condCls}>{r.level}</span>
              </td>
              <td className={tdCls()}>
                <PolarityText polarity={r.polarity} />
                <span className={condCls}>{r.severity}</span>
              </td>
              <td className={tdCls()}>
                {r.agent ? (
                  <AgentTag full text={r.agentText} title={W.addedByAgent} />
                ) : (
                  <span className="text-fg-muted">{r.you}</span>
                )}
              </td>
              <td className={`${tdCls()} text-fg-muted`}>{r.last}</td>
              <td className={tdCls()}>
                <div className="flex justify-end gap-0.5">
                  <button
                    type="button"
                    title={r.mute.title}
                    aria-label={r.mute.label}
                    onClick={r.mute.onPress}
                    disabled={r.mute.disabled}
                    className={`${iconBtn} hover:text-fg`}
                  >
                    {r.mute.glyph}
                  </button>
                  <button
                    type="button"
                    title={r.edit.title}
                    aria-label={r.edit.label}
                    onClick={r.edit.onPress}
                    className={`${iconBtn} hover:text-fg`}
                  >
                    {"✎"}
                  </button>
                  <button
                    type="button"
                    title={r.remove.title}
                    aria-label={r.remove.label}
                    onClick={r.remove.onPress}
                    disabled={r.remove.disabled}
                    className={`${iconBtn} hover:text-negative`}
                  >
                    {"✕"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function History({ h }: { h: AlertsManagerProps["history"] }) {
  return (
    <Widget
      title={h.title}
      count={h.count}
      tight
      flush
      controls={
        h.exportCsv ? (
          <Button variant="link" size="md" onPress={h.exportCsv.onPress}>
            {h.exportCsv.label}
          </Button>
        ) : undefined
      }
    >
      {h.loading ? (
        <div className="px-4">
          <Skeleton height={80} />
        </div>
      ) : h.empty ? (
        <div className={emptyCls}>{h.empty}</div>
      ) : (
        <div className="overflow-x-auto">
          <table className={tableCls(true)}>
            <thead>
              <tr>
                {h.head.map((t, i) => (
                  <th key={t} className={thCls(i === 2)}>
                    {t}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {h.rows.map((r) => (
                <tr key={r.id}>
                  <td className={`${tdCls()} tabular-nums`}>{r.date}</td>
                  <td className={tdCls()}>{r.title}</td>
                  <td className={tdCls(true)}>{r.value}</td>
                  <td className={tdCls()}>
                    <PolarityText polarity={r.polarity} />
                  </td>
                  <td className={tdCls()}>
                    {r.source === "agent" ? (
                      <AgentTag full text={h.agent} title={W.addedByAgent} />
                    ) : (
                      <span className="text-fg-muted">
                        {r.source === "you" ? h.you : h.deleted}
                      </span>
                    )}
                  </td>
                  <td className={tdCls()}>{r.next}</td>
                  <td className={`${tdCls()} ${r.decided ? "" : "text-fg-muted"}`}>{r.decision}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Widget>
  );
}

export function AlertsManagerView(p: AlertsManagerProps) {
  const l = p.list;
  return (
    <>
      <Crumb label={p.crumb.label} items={p.crumb.items} />
      <PageHead
        title={p.title}
        actions={<span className="text-xs text-fg-muted">{p.checked}</span>}
      >
        <Seg
          quiet
          label={p.status.label}
          items={p.status.items}
          value={p.status.value}
          onChange={p.status.onChange}
        />
        <Seg
          quiet
          label={p.source.label}
          items={p.source.items}
          value={p.source.value}
          onChange={p.source.onChange}
        />
      </PageHead>
      <Grid
        items={[
          {
            id: "list",
            span: 2,
            node: (
              <Widget
                title={null}
                label={l.label}
                flush
                footer={
                  <>
                    <span>
                      <b>{l.foot.count}</b> {l.foot.word}
                    </span>
                    <span>
                      {l.foot.limit} <b>{l.foot.limitValue}</b>
                    </span>
                  </>
                }
              >
                {l.loading ? (
                  <div className="px-4">
                    <Skeleton height={160} />
                  </div>
                ) : l.empty ? (
                  <div className={emptyCls}>{l.empty}</div>
                ) : (
                  <Table p={l} />
                )}
              </Widget>
            ),
          },
          { id: "form", span: 1, node: p.form },
          { id: "history", span: 3, node: <History h={p.history} /> },
        ]}
      />
    </>
  );
}
