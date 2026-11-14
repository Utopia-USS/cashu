import type { ReactNode } from "react";

/** One settings row (old `.row`): an optional leading control (a switch), the title line (`.t`, 14px 600,
 * with tags) and a muted detail line (`.d`, 12.5px), extra content under them and an action on the right.
 * Rows are divided by a rule; the last `div` among its siblings has none (old `.row:last-of-type`). */
export interface SettingRowProps {
  title: ReactNode;
  detail?: ReactNode;
  control?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  /** Layout only (old inline `paddingTop: 0`). */
  className?: string;
}

export function SettingRow({
  title,
  detail,
  control,
  action,
  children,
  className = "",
}: SettingRowProps) {
  return (
    <div
      className={`flex items-center gap-3 border-b border-border py-2.5 last-of-type:border-b-0 ${className}`}
    >
      {control}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-md font-strong">{title}</div>
        {detail != null && <div className="text-xs-plus text-fg-muted">{detail}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}
