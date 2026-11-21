// The ported search-to-add field (ab24ab6 v2/InstrumentSearch.tsx; index.css `.isearch`, `.isl`, `.iso`, `.isadd`):
// a combobox input over a listbox of rows (bold ticker, the name under it, exchange and type on the right, then a
// round `+`, a check or nothing), one skeleton row while the answer is on its way. Pure.
import { Skeleton, Tag } from "@cashu/ui";
import type { KeyboardEventHandler, Ref } from "react";
import { inputCls } from "./fields.js";

interface SearchRowProps {
  key: string;
  id: string;
  selected: boolean;
  busy: boolean;
  label: string | undefined;
  content:
    | { kind: "free"; text: string }
    | {
        kind: "hit";
        symbol: string;
        name: string | null;
        tag: { text: string; title?: string } | null;
        exchange: string | null;
        type: string | null;
        mark: "add" | "ok" | null;
      };
  onMove(): void;
  onPress(): void;
}

export interface InstrumentSearchProps {
  inputRef: Ref<HTMLInputElement>;
  value: string;
  onChange(v: string): void;
  onKeyDown: KeyboardEventHandler<HTMLInputElement>;
  placeholder: string;
  label: string;
  listLabel: string;
  listId: string;
  open: boolean;
  activeId: string | undefined;
  waiting: boolean;
  stale: boolean;
  error: string | null;
  noResults: string | null;
  unavailable: string | null;
  rows: SearchRowProps[];
  skeleton: boolean;
}

const addCls =
  "inline-flex size-5.5 cursor-pointer items-center justify-center rounded-full border border-border bg-chip p-0 font-system text-base font-strong leading-none text-accent group-aria-selected:border-accent group-aria-selected:bg-accent group-aria-selected:text-on-accent hover:border-accent hover:bg-accent hover:text-on-accent";

export function InstrumentSearchView({ inputRef, ...p }: InstrumentSearchProps) {
  return (
    <div className="border-b border-border px-4 py-2">
      <input
        ref={inputRef}
        value={p.value}
        maxLength={60}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => p.onChange(e.target.value)}
        onKeyDown={p.onKeyDown}
        placeholder={p.placeholder}
        aria-label={p.label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={p.open}
        aria-controls={p.listId}
        aria-activedescendant={p.activeId}
        className={`w-full ${inputCls()}`}
      />
      {p.error && (
        <div role="alert" className="pt-1.5 text-xs text-negative">
          {p.error}
        </div>
      )}
      {p.noResults && <output className="block pt-1.5 text-xs text-fg-muted">{p.noResults}</output>}
      <div
        id={p.listId}
        role="listbox"
        aria-label={p.listLabel}
        hidden={!p.open}
        aria-busy={p.waiting || undefined}
        className="-mx-2 mt-1.5 mb-0 max-h-88 overflow-y-auto p-0"
      >
        {p.rows.map((r) => (
          <div
            key={r.key}
            id={r.id}
            data-search-key={r.key}
            role="option"
            tabIndex={-1}
            aria-selected={r.selected}
            aria-disabled={p.stale || undefined}
            aria-busy={r.busy || undefined}
            aria-label={r.label}
            onMouseMove={r.onMove}
            onMouseDown={(e) => e.preventDefault()}
            onClick={r.onPress}
            onKeyDown={(e) => {
              // The field drives the list (aria-activedescendant); a focused option still acts on Enter.
              if (e.key === "Enter") r.onPress();
            }}
            className={`group flex min-h-10.5 items-center gap-2.5 rounded-control px-2 py-1.25 ${p.stale ? "cursor-default opacity-45" : "cursor-pointer"} ${r.selected ? "bg-chip" : ""} ${r.busy ? "opacity-60" : ""}`}
          >
            {r.content.kind === "free" ? (
              <>
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="truncate text-sm font-heavy leading-tight tracking-snug tabular-nums">
                    {r.content.text}
                  </span>
                </span>
                <span className="inline-flex w-6 flex-none justify-center">
                  <span aria-hidden="true" className={addCls}>
                    {"+"}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="truncate text-sm font-heavy leading-tight tracking-snug tabular-nums">
                    {r.content.symbol}
                  </span>
                  {r.content.name && (
                    <span
                      title={r.content.name}
                      className="mt-0.5 truncate text-2xs-plus leading-dense text-fg-muted"
                    >
                      {r.content.name}
                    </span>
                  )}
                </span>
                {r.content.tag && (
                  <Tag title={r.content.tag.title} className="flex-none">
                    {r.content.tag.text}
                  </Tag>
                )}
                {(r.content.exchange || r.content.type) && (
                  <span className="flex flex-none flex-col items-end whitespace-nowrap text-2xs leading-row text-fg-muted">
                    {r.content.exchange && <span>{r.content.exchange}</span>}
                    {r.content.type && <span>{r.content.type}</span>}
                  </span>
                )}
                <span className="inline-flex w-6 flex-none justify-center">
                  {r.content.mark === "add" ? (
                    <span aria-hidden="true" className={addCls}>
                      {"+"}
                    </span>
                  ) : r.content.mark === "ok" ? (
                    <span aria-hidden="true" className="text-md font-strong text-positive">
                      {"✓"}
                    </span>
                  ) : null}
                </span>
              </>
            )}
          </div>
        ))}
        {p.skeleton && (
          <div
            aria-hidden="true"
            className="flex min-h-10.5 cursor-default items-center gap-2.5 rounded-control px-2 py-1.25"
          >
            <span className="flex min-w-0 flex-1 flex-col justify-center">
              <Skeleton width={56} height={11} />
              <Skeleton width="60%" height={9} className="mt-1.25" />
            </span>
          </div>
        )}
      </div>
      {p.unavailable && (
        <output className="block pt-1.5 text-xs text-fg-muted">{p.unavailable}</output>
      )}
    </div>
  );
}
