import { C } from "@cashu/i18n/core/common.strings";
import type { ReactNode } from "react";
import { usePressPending } from "../controls/usePressPending.js";
import { Spinner } from "./Spinner.js";

export interface CornerNoticeAction {
  label: string;
  /** A button; with `href` the action is a link that opens a new window instead. When it returns a
   * promise, the button is busy until it settles (a spinner over its label, further presses ignored). */
  onPress?: () => unknown;
  href?: string;
  primary?: boolean;
  title?: string;
  disabled?: boolean;
}

export interface CornerNoticeProps {
  title: string;
  /** The muted line under the title. */
  sub?: string;
  /** `warning`: the icon on the warning tint (a failure). */
  tone?: "warning";
  /** The close glyph; omitted = the card cannot be closed (a step in progress). */
  onClose?: () => void;
  /** Accessible name and tooltip of the close glyph (default `Zamknij`). */
  closeLabel?: string;
  /** 0-100 = a progress bar under the text; null = a bar without a known amount (empty). */
  progress?: number | null;
  actions?: readonly CornerNoticeAction[];
  children?: ReactNode;
}

const action =
  "inline-block cursor-pointer whitespace-nowrap rounded-control border px-2.5 py-1 text-xs leading-cozy no-underline disabled:cursor-default disabled:opacity-60";

/** A small status card fixed in the bottom-left corner (old UpdateNotice `.upd`): round icon, 13px title, 12px
 * muted line, actions or a progress bar, a close glyph. A polite live region; below the drawers' scrims. */
export function CornerNotice({
  title,
  sub,
  tone,
  onClose,
  closeLabel = C.close,
  progress,
  actions,
  children,
}: CornerNoticeProps) {
  return (
    <aside
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-4 z-30 flex w-75 max-w-[calc(100%-(--spacing(8)))] animate-corner-in items-start gap-2.5 rounded-widget border border-border bg-surface-raised py-3 pr-2.5 pl-3 text-fg shadow-corner motion-reduce:animate-none"
    >
      <span
        aria-hidden="true"
        className={`grid size-6.5 flex-none place-items-center rounded-full ${tone === "warning" ? "bg-warning-bg text-warning" : "bg-info-bg text-accent"}`}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path
            d="M8 12.5V3.5M4 7.5l4-4 4 4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="mt-0.75 text-sm leading-row font-strong">{title}</div>
        {sub ? <div className="mt-px text-xs text-fg-muted">{sub}</div> : null}
        {progress !== undefined && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress ?? undefined}
            className="mt-2 h-1 overflow-hidden rounded-4xs bg-chip"
          >
            <span
              className="block h-full bg-accent transition-[width] duration-300 ease-out"
              style={{ width: `${progress ?? 0}%` }}
            />
          </div>
        )}
        {actions && actions.length > 0 && (
          <div className="mt-2.5 flex gap-2">
            {actions.map((item) => {
              const look = `${action} ${item.primary ? "border-accent bg-accent text-on-accent" : "border-border bg-chip text-chip-fg"}`;
              return item.href ? (
                <a
                  key={item.label}
                  className={look}
                  href={item.href}
                  title={item.title}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {item.label}
                </a>
              ) : (
                <ActionButton key={item.label} item={item} className={look} />
              );
            })}
          </div>
        )}
        {children}
      </div>
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
          className="grid size-5.5 flex-none cursor-pointer place-items-center rounded-sm border-0 bg-transparent p-0 text-fg-muted hover:bg-chip hover:text-fg"
        >
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </aside>
  );
}

/** One action button; busy (spinner over the kept-width label) while its press promise runs. */
function ActionButton({ item, className }: { item: CornerNoticeAction; className: string }) {
  const busy = usePressPending(item.onPress, undefined);
  return (
    <button
      type="button"
      className={`${className} ${busy.inFlight ? "cursor-progress" : ""}`}
      title={item.title}
      disabled={item.disabled && !busy.inFlight}
      aria-busy={busy.inFlight || undefined}
      onClick={busy.press}
    >
      {busy.visible ? (
        <span className="relative inline-grid place-items-center align-bottom">
          <span className="col-start-1 row-start-1 opacity-0">{item.label}</span>
          <Spinner immediate className="col-start-1 row-start-1" />
        </span>
      ) : (
        item.label
      )}
    </button>
  );
}
