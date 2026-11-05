import type { ReactNode } from "react";

export interface PageHeadProps {
  /** Page title (h2, 20px). */
  title: ReactNode;
  /** Items after the title: filters, status tags. */
  children?: ReactNode;
  /** Items pushed to the right end: page actions. */
  actions?: ReactNode;
  /** Layout only. */
  className?: string;
}

/** Page header row (old `.pagehead` with `h2.ph` and `.spacer`). */
export function PageHead({ title, children, actions, className = "" }: PageHeadProps) {
  return (
    <div className={`mb-3.5 flex flex-wrap items-center gap-3 ${className}`}>
      <h2 className="m-0 text-2xl font-heavy tracking-heading">{title}</h2>
      {children}
      <span className="flex-1" />
      {actions}
    </div>
  );
}
