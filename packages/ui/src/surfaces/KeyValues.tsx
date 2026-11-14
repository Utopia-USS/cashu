import type { ReactNode } from "react";

/** One key / value pair of a `KeyValues` grid. */
export interface KeyValueRow {
  key: string;
  label: ReactNode;
  /** The key becomes a `<label for>` of this control (old `<label className="k" htmlFor>`). */
  htmlFor?: string;
  /** Tooltip of the key. */
  title?: string;
  value: ReactNode;
  /** Value as a block (old `.v.block`: a code line, a multi-line command) instead of a wrapping row. */
  block?: boolean;
}

export interface KeyValuesProps {
  rows: readonly KeyValueRow[];
  /** Key column: `page` 190px (old `.kv`), `narrow` 150px (old `.drawer .kv`, `.wizard .summary .kv`). */
  keyWidth?: "page" | "narrow";
  /** Old `.drawer .kv.ckv`: rows aligned on the text baseline, 8px between rows. */
  baseline?: boolean;
  /** Layout only (margin). */
  className?: string;
}

/** Key-value grid (old `.kv`): 190px muted keys (13px), values in a wrapping row (14px, gap 8); the rows
 * stack at <= 640px with 8px above each key. */
export function KeyValues({ rows, keyWidth = "page", baseline, className = "" }: KeyValuesProps) {
  const key = "text-sm text-fg-muted max-kv:mt-2";
  const columns =
    keyWidth === "narrow"
      ? "grid-cols-[--spacing(37.5)_minmax(0,1fr)]"
      : "grid-cols-[--spacing(47.5)_minmax(0,1fr)]";
  return (
    <div
      className={`grid ${columns} gap-x-4 text-md max-kv:grid-cols-[minmax(0,1fr)] max-kv:gap-x-0 max-kv:gap-y-1 ${baseline ? "items-baseline gap-y-2" : "items-center gap-y-2.5"} ${className}`}
    >
      {rows.map((row) => (
        <KeyValuePair key={row.key} row={row} keyCls={key} />
      ))}
    </div>
  );
}

function KeyValuePair({ row, keyCls }: { row: KeyValueRow; keyCls: string }) {
  return (
    <>
      {row.htmlFor ? (
        <label className={keyCls} htmlFor={row.htmlFor} title={row.title}>
          {row.label}
        </label>
      ) : (
        <span className={keyCls} title={row.title}>
          {row.label}
        </span>
      )}
      <span className={row.block ? "block min-w-0" : "flex min-w-0 flex-wrap items-center gap-2"}>
        {row.value}
      </span>
    </>
  );
}
