import type { ReactNode } from "react";

const notices = {
  neutral: "border-border bg-chip",
  info: "border-info bg-info-bg",
  warning: "border-warning bg-warning-bg",
  negative: "border-negative bg-negative-bg",
  positive: "border-positive bg-positive-bg",
} as const;

/** Soft message box (old `.notice`, softer than `.err`). `className` is layout only (margin). */
export interface NoticeProps {
  tone?: keyof typeof notices;
  children: ReactNode;
  className?: string;
}

export function Notice({ tone = "neutral", children, className = "mb-3" }: NoticeProps) {
  return (
    <div
      className={`flex items-center gap-3 rounded-control border px-3.5 py-2.5 text-sm ${notices[tone]} ${className}`}
    >
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
