import { Button, Tag } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { T } from "./Devices.strings.js";
import type { DeviceRow } from "./deviceRows.js";

const note = "col-span-2 col-start-2 flex items-center gap-2.5 rounded-control px-3 py-2 text-sm";
const item =
  "grid w-full cursor-pointer gap-0.5 rounded-sm border-none bg-transparent px-2.5 py-2 text-left text-md hover:bg-chip focus-visible:bg-chip focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent";

/** One device of the profile: name and tags, its facts on one line, the row menu and its notes. */
export function DeviceRowItem({
  row,
  disabled,
  onFetch,
  onRemove,
}: {
  row: DeviceRow;
  /** The list is stale (host handover) or an action is in flight: the actions wait. */
  disabled: boolean;
  onFetch(device: string): void;
  onRemove(device: string): void;
}) {
  const [menu, setMenu] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // An open menu closes on a press outside it and on Escape.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setMenu(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menu]);
  const facts = [
    row.origin.kind === "recovery"
      ? T.addedRecovery(row.addedOn)
      : row.origin.kind === "device"
        ? T.addedBy(row.addedOn, row.origin.by)
        : row.addedOn === null
          ? null
          : T.added(row.addedOn),
    row.removedCopyOn === null ? null : T.removedCopyOn(row.removedCopyOn),
  ].filter((fact) => fact !== null);
  const hasMenu = row.fetchItem !== null || row.removable;
  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-border border-t px-4.5 py-3.5 first:border-t-0"
      data-device={row.id}
    >
      <span
        aria-hidden
        className={`grid size-8 place-items-center rounded-control bg-chip text-fg-secondary ${row.removedCopyOn === null ? "" : "opacity-50"}`}
      >
        <DeviceIcon />
      </span>
      <div className={`grid gap-0.5 ${row.removedCopyOn === null ? "" : "text-fg-muted"}`}>
        <div className="flex flex-wrap items-center gap-2 font-strong">
          <span>{row.name}</span>
          {row.thisMac && <Tag>{T.thisMac}</Tag>}
          {row.fetches && <Tag tone="info">{T.fetches}</Tag>}
        </div>
        <p className="text-sm text-fg-muted">{facts.join(" · ")}</p>
      </div>
      {hasMenu ? (
        <div ref={box} className="relative">
          <Button
            variant="ghost"
            size="sm"
            label={T.rowMenu(row.name)}
            expanded={menu}
            disabled={disabled}
            onPress={() => setMenu(!menu)}
          >
            …
          </Button>
          {menu && (
            <div
              role="menu"
              aria-label={T.rowMenu(row.name)}
              className="absolute top-full right-0 z-10 mt-1 grid min-w-60 rounded-control border border-border bg-surface-overlay p-1 shadow-lg"
            >
              {row.fetchItem !== null && (
                <button
                  type="button"
                  role="menuitem"
                  className={item}
                  disabled={!row.fetchItem.enabled}
                  onClick={() => {
                    setMenu(false);
                    onFetch(row.id);
                  }}
                >
                  <span>{T.fetchHere}</span>
                  {!row.fetchItem.enabled && (
                    <span className="text-xs text-fg-muted">{T.menuFetchLater}</span>
                  )}
                </button>
              )}
              {row.removable && (
                <button
                  type="button"
                  role="menuitem"
                  className={`${item} text-negative`}
                  onClick={() => {
                    setMenu(false);
                    onRemove(row.id);
                  }}
                >
                  {T.menuRemove}
                </button>
              )}
            </div>
          )}
        </div>
      ) : (
        <span />
      )}
      {row.forked && (
        <p role="alert" className={`${note} bg-warning-bg text-warning`}>
          {T.forked}
        </p>
      )}
      {row.behind && (
        <p role="status" className={`${note} bg-warning-bg text-warning`}>
          {T.behind(row.name)}
        </p>
      )}
      {row.removedCopyOn !== null && (
        <div className={`${note} bg-chip text-fg-secondary`}>
          <span className="flex-1">{T.removedCopy(row.name, row.removedCopyOn)}</span>
          <Button size="sm" disabled={disabled} onPress={() => onRemove(row.id)}>
            {T.removeLeft}
          </Button>
        </div>
      )}
    </li>
  );
}

/** The one generic device glyph of every row (the list cannot tell a phone from a Mac). */
function DeviceIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="3" width="16" height="13" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </svg>
  );
}
