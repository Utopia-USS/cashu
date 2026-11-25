import type { ReactNode } from "react";

export interface EmptyProps {
  /** The empty state's line (text colour, 600). */
  title: ReactNode;
  /** Muted 13px line under the title. */
  hint?: ReactNode;
  /** Controls under the text, centred (a button or two). */
  action?: ReactNode;
  /** Inside a widget body (old `.w .empty`: 18px 12px, 13px); default = a page block (28px 20px, 14px). */
  inWidget?: boolean;
  /** Layout only (margin). */
  className?: string;
}

/** Empty state block (old ui.tsx `Empty` / `.empty`): centred muted text, a title in the text colour, an
 * optional hint and an action row. One-line empties without a title use `emptyCls` (widgetTable.ts). */
export function Empty({ title, hint, action, inWidget = false, className = "" }: EmptyProps) {
  return (
    <div
      className={`text-center text-fg-muted ${inWidget ? "px-3 py-4.5 text-sm" : "px-5 py-7 text-md"} ${className}`}
    >
      <div className="font-strong text-fg">{title}</div>
      {hint != null && <div className="mt-1 text-sm">{hint}</div>}
      {action != null && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">{action}</div>
      )}
    </div>
  );
}
