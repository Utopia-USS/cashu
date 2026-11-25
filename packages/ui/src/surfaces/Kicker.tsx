import type { ReactNode } from "react";

export interface KickerProps {
  /** The 11px uppercase heading (old `.kicker`). */
  title: ReactNode;
  /** Right after the heading (a count `Tag`, then a spacer and a button). */
  children?: ReactNode;
}

/** A section heading inside a drawer (old `.drawer .kick`): flex row, 16px above (none for the first child),
 * 6px below; the heading 11px uppercase .06em muted 600. */
export function Kicker({ title, children }: KickerProps) {
  return (
    <div className="mt-4 mb-1.5 flex items-center gap-2 first:mt-0">
      <span className="text-2xs font-strong uppercase tracking-eyebrow text-fg-muted">{title}</span>
      {children}
    </div>
  );
}
