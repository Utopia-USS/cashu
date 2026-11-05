import type { ReactNode } from "react";
import { ControlRow } from "./ChartCard.js";

/** A titled page card (old `.card.chart-card` + `section h2`): card fill, border, radius 12, padding
 * 16px 18px, 18px below; the heading is 14px bold uppercase .04em muted, 12px above the content. With `tags`
 * the heading sits in the old `.controls` row (margin 0) followed by the tags (old Kredyty list head). */
export interface SectionCardProps {
  /** The section's id; the heading gets `${id}-h` and names the region. */
  id: string;
  title: ReactNode;
  /** After the heading on one row (a count `Tag`). */
  tags?: ReactNode;
  children?: ReactNode;
  /** Layout only (scroll margin, spacing). */
  className?: string;
}

const headingCls = "mt-0 text-md font-bold uppercase tracking-caps text-fg-muted";

export function SectionCard({ id, title, tags, children, className = "" }: SectionCardProps) {
  const heading = (
    <h2 id={`${id}-h`} className={`${headingCls} ${tags != null ? "mb-0" : "mb-3"}`}>
      {title}
    </h2>
  );
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`mb-4.5 rounded-widget border border-border bg-surface-raised px-4.5 py-4 ${className}`}
    >
      {tags != null ? (
        <ControlRow>
          {heading}
          {tags}
        </ControlRow>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}
