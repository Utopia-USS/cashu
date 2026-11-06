// The import drawer shared by the bank statement import (old modules/budget/ImportDrawer.tsx) and the broker
// import (old modules/investments/Drawers.tsx ImportDrawer): the 600px side drawer with the stepper and the
// error notice, the preview's counts row, its table (old global `table` inside `.drawer`) and the done block.
// The screens compose their steps' fields and the columns; every text arrives formatted.
import type { ReactNode } from "react";
import { Stepper } from "../lists/Stepper.js";
import { Notice } from "../surfaces/Notice.js";
import { Tag } from "../surfaces/Tag.js";
import { Drawer } from "./Drawer.js";

export interface ImportDrawerProps {
  title: string;
  /** The account / bank tag next to the title. */
  tag?: string | null;
  steps: readonly string[];
  /** 0-based current step. */
  step: number;
  /** The error notice under the stepper (old `Notice tone="neg"`). */
  error?: ReactNode;
  footer: ReactNode;
  onClose(): void;
  children?: ReactNode;
}

/** Old `<Drawer width={600}>` + `<Stepper>` + the negative notice. */
export function ImportDrawer(props: ImportDrawerProps) {
  return (
    <Drawer
      title={props.title}
      label={props.title}
      width={600}
      tag={props.tag ? <Tag>{props.tag}</Tag> : undefined}
      footer={props.footer}
      onClose={props.onClose}
    >
      <Stepper steps={props.steps} current={props.step} />
      {props.error != null && props.error !== false && (
        <Notice tone="negative">{props.error}</Notice>
      )}
      {props.children}
    </Drawer>
  );
}

/** A text node as a constant: the DOM-only markup keeps the old space (raw JSX text is for <Text>). */
const SP = " ";

/** Muted helper text (old `.fhint`: 12px muted). */
export const importHintCls = "text-xs text-fg-muted";

/** The drawers' checkbox (old `.check`: 15px, accent colour). The old app kept the UA checkbox margin
 * (3px 3px 3px 4px), which the preflight resets, so it is restored here. */
export const importCheckCls = "my-0.75 mr-0.75 ml-1 size-3.75 accent-accent";

export interface ImportCountsProps {
  /** "12 nowych" (solid positive tag). */
  fresh: string;
  /** "3 duplikaty" (plain tag) with an optional tooltip. */
  duplicates: string;
  duplicatesTitle?: string;
  /** "2 pominięte" (solid warning tag), null = none. */
  skipped?: string | null;
  skippedTitle?: string;
  /** The filter checkbox on the right ("pokaż tylko nowe" / "tylko problemy"). */
  filter: { label: string; on: boolean; onChange(on: boolean): void };
}

/** The preview's counts row (old `.controls`: tags, spacer, the 12px muted checkbox label). */
export function ImportCounts(props: ImportCountsProps) {
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <Tag tone="positive" solid>
        {props.fresh}
      </Tag>
      <Tag title={props.duplicatesTitle}>{props.duplicates}</Tag>
      {props.skipped && (
        <Tag tone="warning" solid title={props.skippedTitle}>
          {props.skipped}
        </Tag>
      )}
      <span className="flex-1" />
      <label className="flex items-center gap-1.5 text-xs text-fg-muted">
        <input
          type="checkbox"
          className={importCheckCls}
          checked={props.filter.on}
          onChange={(e) => props.filter.onChange(e.target.checked)}
        />
        {SP}
        {props.filter.label}
      </label>
    </div>
  );
}

export interface ImportColumn {
  key: string;
  label: string;
  num?: boolean;
  title?: string;
}

/** Cells of the drawer tables (old global `th` / `td` with `.drawer th, td { padding: 6px 4px }`, 13px, every
 * cell but the last on one line, `td.num` right-aligned tabular). */
export const importTable = {
  table: "w-full border-collapse text-sm",
  th: (num?: boolean) =>
    `border-b border-border px-1 py-1.5 text-xs font-strong uppercase tracking-column text-fg-muted whitespace-nowrap last:whitespace-normal ${num ? "text-right tabular-nums" : "text-left"}`,
  td: (num?: boolean) =>
    `border-b border-border px-1 py-1.5 whitespace-nowrap last:whitespace-normal ${num ? "text-right tabular-nums" : "text-left"}`,
} as const;

export interface ImportTableProps {
  columns: readonly ImportColumn[];
  /** Body rows (`<tr>` built with `importTable.td`). */
  children?: ReactNode;
  /** "… 40 kolejnych wierszy · " with its "pokaż wszystkie" link, null = all shown. */
  more?: { text: string; action: ReactNode } | null;
  /** The muted row when nothing is listed. */
  empty?: string | null;
}

/** The preview table with its "more rows" and empty rows. */
export function ImportTable({ columns, children, more, empty }: ImportTableProps) {
  return (
    <table className={importTable.table}>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={importTable.th(c.num)} title={c.title}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {children}
        {more && (
          <tr>
            <td
              colSpan={columns.length}
              className={`${importTable.td()} text-center text-xs text-fg-muted`}
            >
              {more.text}
              {more.action}
            </td>
          </tr>
        )}
        {empty && (
          <tr>
            <td colSpan={columns.length} className={`${importTable.td()} text-fg-muted`}>
              {empty}
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

export interface ImportDoneProps {
  /** "Zaimportowano 12 transakcji." (600, text colour). */
  title: string;
  /** The 13px line under it. */
  line?: string;
  /** Buttons (old `.controls` left-aligned). */
  actions?: ReactNode;
}

/** The done step (old `.empty` left-aligned, padding 8px 0: 14px muted, title 600 in the text colour). */
export function ImportDone({ title, line, actions }: ImportDoneProps) {
  return (
    <div className="py-2 text-left text-md text-fg-muted">
      <div className="font-strong text-fg">{title}</div>
      {line != null && <div className="mt-1 text-sm">{line}</div>}
      <div className="mt-3 flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}
