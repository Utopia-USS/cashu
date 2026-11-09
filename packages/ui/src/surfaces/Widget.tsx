import { type PointerEvent, type ReactNode, useId } from "react";
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
  /** `eyebrow` (default): the dashboard header (uppercase 11.5px eyebrow, 16px padding, subtle footer band).
   * `quiet`: the investments home look (design V5): a sentence-case 13px / 500 secondary title, 20px padding,
   * 16px under the header, a footer on a hairline without a band. */
  variant?: "eyebrow" | "quiet";
  /** The layered tile of the overview bento (design/desktop/overview/layered-tiles.html): a top-lit gradient
   * over the card colour, an inset hairline with a lit top edge and a soft drop shadow instead of the border;
   * hovered, it lifts 2px and a spotlight follows the cursor; the footer sits on the tile without a band or
   * hairline. `ghost` keeps its dashed frame, `highlight` adds the accent outline. */
  layered?: boolean;
  /** A layered tile that does not lift on hover (it holds a scrubbed chart). */
  still?: boolean;
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
  layered: "tile-layered",
  layeredHighlight: "outline -outline-offset-1 outline-accent",
} as const;

/** The layered tile's cursor spotlight: its position in the tile as CSS variables (no React state). */
function followSpot(event: PointerEvent<HTMLElement>) {
  const tile = event.currentTarget;
  const box = tile.getBoundingClientRect();
  tile.style.setProperty("--spot-x", `${event.clientX - box.left}px`);
  tile.style.setProperty("--spot-y", `${event.clientY - box.top}px`);
}

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
  variant = "eyebrow",
  layered = false,
  still = false,
  id,
  label,
  children,
  className = "",
}: WidgetProps) {
  const headingId = useId();
  const tile = layered && !ghost;
  const frame = ghost
    ? frames.ghost
    : tile
      ? `${frames.layered} ${still ? "" : "tile-lift"} ${highlight ? frames.layeredHighlight : ""}`
      : highlight
        ? frames.highlight
        : tint
          ? tints[tint]
          : frames.plain;
  const hasHead = title != null || count != null || tags != null || controls != null;
  const look = looks[variant];
  const bodyBottom = tile && footer != null ? "pb-3" : look.body;
  return (
    <section
      id={id}
      aria-labelledby={label ? undefined : headingId}
      aria-label={label}
      onPointerMove={tile ? followSpot : undefined}
      className={`flex min-w-0 flex-col rounded-widget ${tile ? "" : "border"} ${frame} ${className}`}
    >
      {hasHead && (
        <div className={look.head}>
          {title != null && (
            <h3 id={headingId} className={`${look.title} ${tint ? tintInk : look.titleInk}`}>
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
          className={`min-w-0 flex-1 ${bodyBottom} ${tight ? look.tight : look.top} ${flush ? "px-0" : look.side}`}
        >
          {children}
        </div>
      )}
      {footer != null && <div className={tile ? layeredFooter : look.footer}>{footer}</div>}
    </section>
  );
}

const footerText = "text-xs text-fg-muted [&_b]:font-strong [&_b]:text-fg [&_b]:tabular-nums";
/** The layered tile's footer: on the tile at its bottom, no band or hairline (the mockup's `.t-foot`). */
const layeredFooter = `flex min-h-8 flex-wrap items-center gap-x-3.5 gap-y-1.5 px-5 pb-4.5 ${footerText}`;
/** The two header / body / footer looks of `Widget` (`variant`). */
const looks = {
  eyebrow: {
    head: "flex min-h-9 flex-wrap items-center gap-2 px-4 pt-3",
    title: "m-0 whitespace-nowrap text-2xs-plus font-strong uppercase tracking-eyebrow",
    titleInk: "text-fg-muted",
    body: "pb-3.5",
    top: "pt-2.5",
    tight: "pt-1.5",
    side: "px-4",
    footer: `flex flex-wrap items-center gap-x-3.5 gap-y-1.5 rounded-b-widget border-t border-border bg-subtle px-4 py-2 ${footerText}`,
  },
  quiet: {
    head: "flex min-h-7 flex-wrap items-center gap-2.5 px-5 pt-5",
    title: "m-0 whitespace-nowrap text-sm font-medium",
    titleInk: "text-fg-secondary",
    body: "pb-5",
    top: "pt-4",
    tight: "pt-3",
    side: "px-5",
    footer: `flex min-h-11 flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-border px-5 py-2 ${footerText}`,
  },
} as const;

export interface WidgetSectionProps {
  /** Section title (the quiet sentence-case header of `Widget variant="quiet"`); names the region. */
  title: ReactNode;
  /** Quiet items after the title (a count, a status). */
  tags?: ReactNode;
  /** Controls at the header's right end (an `All (n)` link). */
  controls?: ReactNode;
  /** A quiet line under the body (counts, links). */
  footer?: ReactNode;
  id?: string;
  children?: ReactNode;
  /** Layout only. */
  className?: string;
}

/** One section of a sectioned card (design V5 rail: signals, alerts and candidates in one card): a region named
 * by its quiet sentence-case header; sections after the first sit under a hairline. Place them as the children of
 * a `Widget variant="quiet"` without a title. */
export function WidgetSection({
  title,
  tags,
  controls,
  footer,
  id,
  children,
  className = "",
}: WidgetSectionProps) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`min-w-0 [&+&]:mt-5 [&+&]:border-t [&+&]:border-border [&+&]:pt-4.5 ${className}`}
    >
      <div className="mb-1 flex min-h-6 items-center gap-2">
        <h3 id={headingId} className={`${looks.quiet.title} ${looks.quiet.titleInk}`}>
          {title}
        </h3>
        {tags}
        {controls != null && (
          <>
            <span className="flex-1" />
            <div className="flex flex-wrap items-center gap-1.5">{controls}</div>
          </>
        )}
      </div>
      {children}
      {footer != null && (
        <div className={`mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1.5 ${footerText}`}>
          {footer}
        </div>
      )}
    </section>
  );
}
