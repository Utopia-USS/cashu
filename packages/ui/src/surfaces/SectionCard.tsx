import type { ReactNode } from "react";

/** A titled page card (old `.card.chart-card` + `section h2`): card fill, border, radius 12, padding
 * 16px 18px, 18px below; the heading is 14px bold uppercase .04em muted, 12px above the content. */
export interface SectionCardProps {
  /** The section's id; the heading gets `${id}-h` and names the region. */
  id: string;
  title: ReactNode;
  children?: ReactNode;
  /** Layout only (scroll margin, spacing). */
  className?: string;
}

export function SectionCard({ id, title, children, className = "" }: SectionCardProps) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-h`}
      className={`mb-4.5 rounded-widget border border-border bg-surface-raised px-4.5 py-4 ${className}`}
    >
      <h2
        id={`${id}-h`}
        className="mt-0 mb-3 text-md font-bold uppercase tracking-caps text-fg-muted"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}
