import { Button, Tag } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { T } from "./Devices.strings.js";
import type { DeviceRow } from "./deviceRows.js";

const note = "col-span-2 col-start-1 flex items-center gap-2.5 rounded-control px-3 py-2 text-sm";
const item =
  "grid w-full cursor-pointer gap-0.5 rounded-sm border-none bg-transparent px-2.5 py-2 text-left text-md hover:bg-chip focus-visible:bg-chip focus-visible:outline-none disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent";

/**
 * One device of the profile: name and tags, its facts on one line, the row menu and its notes. No
 * device glyph until the list knows a device's kind (designer DV2 item 1).
 */
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
      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-border border-t px-4.5 py-3.5 first:border-t-0"
      data-device={row.id}
    >
      <div className={`grid gap-0.5 ${row.removedCopyOn === null ? "" : "text-fg-muted"}`}>
        <div className="flex flex-wrap items-center gap-2 font-strong">
          <span>{row.name}</span>
          {row.thisMac && <Tag>{T.thisMac}</Tag>}
          {row.fetches && <Tag tone="info">{T.fetches}</Tag>}
          {row.fetchPaused && <Tag tone="warning">{T.fetchPausedTag}</Tag>}
        </div>
        <p className="text-sm text-fg-muted">{facts.join(" · ")}</p>
      </div>
      {hasMenu ? (
        <div ref={box} className="relative">
          <Button
            variant="glyph"
            label={T.rowMenu(row.name)}
            title={T.rowMenu(row.name)}
            expanded={menu}
            disabled={disabled}
            onPress={() => setMenu(!menu)}
          >
            <MoreGlyph />
          </Button>
          {menu && (
            <div
              role="menu"
              aria-label={T.rowMenu(row.name)}
              className="absolute top-full right-0 z-10 mt-1 grid w-max min-w-60 rounded-control border border-border bg-surface-overlay p-1 shadow-lg"
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
                  <span className="whitespace-nowrap">{T.fetchHere}</span>
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

/** The row menu's glyph: three dots in the text colour, so it reads in both themes. */
function MoreGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      <circle cx="3" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="13" cy="8" r="1.5" />
    </svg>
  );
}
