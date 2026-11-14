import type { ReactNode } from "react";

const notices = {
  neutral: "border-border bg-chip",
  info: "border-info bg-info-bg",
  warning: "border-warning bg-warning-bg",
  // old `.notice.neg` / `.notice.pos` also take the global `.neg` / `.pos` text colour
  negative: "border-negative bg-negative-bg text-negative",
  positive: "border-positive bg-positive-bg text-positive",
} as const;

/** Soft message box (old `.notice`, softer than `.err`). `className` is layout only (margin). */
export interface NoticeProps {
  tone?: keyof typeof notices;
  children: ReactNode;
  /** A control on the right of the text (old `Notice action`), e.g. a retry button. */
  action?: ReactNode;
  /** Live region role; the old ui.tsx Notice made warning / negative notices alerts. */
  role?: "alert" | "status";
  className?: string;
}

export function Notice({
  tone = "neutral",
  children,
  action,
  role,
  className = "mb-3",
}: NoticeProps) {
  return (
    <div
      role={role}
      className={`flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-sm ${notices[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}
