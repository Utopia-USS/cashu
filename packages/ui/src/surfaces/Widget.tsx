import { type ReactNode, useId } from "react";
import { Tag } from "./Tag.js";

export interface WidgetProps {
  /** Header title (uppercase eyebrow); null = no header text (then pass `label`). */
  title: ReactNode;
  /** A count next to the title, shown as a neutral tag. */
  count?: ReactNode;
  /** More tags after the title (e.g. a toned `Tag`). */
  tags?: ReactNode;
  /** Controls at the header's right end (segments, links, small buttons). */
  controls?: ReactNode;
  /** Footer band (quiet subtle strip, 12px muted, `<b>` values in the text colour). */
  footer?: ReactNode;
  /** Highlighted frame (accent border and ring). */
  highlight?: boolean;
  /** Dashed placeholder frame without fill or shadow. */
  ghost?: boolean;
  /** A state tint of the whole card (old `.w.recw.maybe` / `.out`): 14 % of the hue over the card, the border
   * at 35 %, the title in a 72 % ink. Put the same ink on quiet text inside with `tintInk`. */
  tint?: "warning" | "negative";
  /** Body with less top padding. */
  tight?: boolean;
  /** Body without side padding (tables edge to edge). */
  flush?: boolean;
  id?: string;
  /** Accessible name when the title is not plain text. */
  label?: string;
  children?: ReactNode;
  /** Layout only (grid placement, margin); identity comes from the widget. */
  className?: string;
}

/** The quiet-text colour on a tinted widget (old `.w.recw.* .muted`): 72 % text over the card. */
export const tintInk = "text-[color-mix(in_srgb,var(--color-fg)_72%,var(--color-surface-raised))]";
const tints = {
  warning:
    "border-[color-mix(in_srgb,var(--color-warning)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-warning)_14%,var(--color-surface-raised))] shadow-card",
  negative:
    "border-[color-mix(in_srgb,var(--color-negative)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-negative)_14%,var(--color-surface-raised))] shadow-card",
} as const;
const frames = {
  plain: "border-border bg-surface-raised shadow-card",
  highlight: "border-accent bg-surface-raised shadow-none ring-1 ring-accent",
  ghost: "border-dashed border-border bg-transparent shadow-none",
} as const;

/** Widget frame of the dashboards (old `.w` with `.wh` head, `.wb` body, `.wf` footer): a landmark section
 * named by its title. */
export function Widget({
  title,
  count,
  tags,
  controls,
  footer,
  highlight,
  ghost,
  tint,
  tight,
  flush,
  id,
  label,
  children,
  className = "",
}: WidgetProps) {
  const headingId = useId();
  const frame = ghost
    ? frames.ghost
    : highlight
      ? frames.highlight
      : tint
        ? tints[tint]
        : frames.plain;
  const hasHead = title != null || count != null || tags != null || controls != null;
  return (
    <section
      id={id}
      aria-labelledby={label ? undefined : headingId}
      aria-label={label}
      className={`flex min-w-0 flex-col rounded-widget border ${frame} ${className}`}
    >
      {hasHead && (
        <div className="flex min-h-9 flex-wrap items-center gap-2 px-4 pt-3">
          {title != null && (
            <h3
              id={headingId}
              className={`m-0 whitespace-nowrap text-2xs-plus font-strong uppercase tracking-eyebrow ${tint ? tintInk : "text-fg-muted"}`}
            >
              {title}
            </h3>
          )}
          {count != null && <Tag>{count}</Tag>}
          {tags}
          {controls != null && (
            <>
              <span className="flex-1" />
              <div className="flex flex-wrap items-center gap-1.5">{controls}</div>
            </>
          )}
        </div>
      )}
      {children != null && (
        <div
          className={`min-w-0 flex-1 pb-3.5 ${tight ? "pt-1.5" : "pt-2.5"} ${flush ? "px-0" : "px-4"}`}
        >
          {children}
        </div>
      )}
      {footer != null && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-b-widget border-t border-border bg-subtle px-4 py-2 text-xs text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums">
          {footer}
        </div>
      )}
    </section>
  );
}
