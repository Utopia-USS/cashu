import type { ReactNode } from "react";

/** The old `.controls` row: wrapped flex, 8px gaps, centred, 12px below (`className` overrides the margin). */
export function ControlRow({
  children,
  className = "mb-3",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`flex flex-wrap items-center gap-2 ${className}`}>{children}</div>;
}

export interface ChartCardProps {
  /** Bold 14px title at the start of the head row (old `.controls strong`). */
  title?: ReactNode;
  /** Right after the title (a `Tag`). */
  tags?: ReactNode;
  /** After the spacer at the end of the head row (switches, period stepper, close button). */
  controls?: ReactNode;
  /** Accessible name: the card becomes a named `section` (old month close); without it a plain box. */
  label?: string;
  /** The card is loading new content (`aria-busy`). */
  busy?: boolean;
  children?: ReactNode;
  /** Layout only. */
  className?: string;
}

/** A page card of the budget tabs (old `.card.chart-card`: card fill, border, radius 12, padding 16px 18px, 18px
 * below) with the old `.controls` head row when a title or controls are given. */
export function ChartCard({
  title,
  tags,
  controls,
  label,
  busy,
  children,
  className = "",
}: ChartCardProps) {
  const head =
    title != null || controls != null ? (
      <ControlRow>
        {title != null && <strong className="text-md font-bold">{title}</strong>}
        {tags}
        <span className="flex-1" />
        {controls}
      </ControlRow>
    ) : null;
  const cls = `mb-4.5 rounded-widget border border-border bg-surface-raised px-4.5 py-4 ${className}`;
  return label != null ? (
    <section aria-label={label} aria-busy={busy || undefined} className={cls}>
      {head}
      {children}
    </section>
  ) : (
    <div aria-busy={busy || undefined} className={cls}>
      {head}
      {children}
    </div>
  );
}
