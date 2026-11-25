import type { ReactNode } from "react";

export interface FactProps {
  /** Uppercase caption above the value. */
  label: ReactNode;
  value: ReactNode;
  /** Muted line under the value; omitted when null or empty. */
  detail?: ReactNode;
  /** Colour of the value. */
  tone?: "positive" | "negative" | "warning" | "accent";
  /** Value size: `lg` 17px (default), `md` 16px (hero strip), `sm` 14px; `xl` = the month close figure (old
   * `.mc-fig`: caption .04em, value 19px 4px below (17px at <= 560px), detail 2px below). */
  size?: "xl" | "lg" | "md" | "sm";
  /** Tooltip of the whole fact. */
  title?: string;
  /** A small layered sub-tile inside a layered tile (the overview hero's facts, design/desktop/overview/
   * layered-tiles.html `.fact`): its own top-lit surface with a 16px radius, the label sentence case (12px
   * muted), the value 17px, the detail one line (ellipsis). */
  tile?: boolean;
  /** Layout only (padding and dividers of a strip, grid placement). */
  className?: string;
}

const sizes = {
  xl: "mt-1 text-xl max-close:text-lg",
  lg: "mt-px text-lg",
  md: "mt-px text-base-plus",
  sm: "mt-px text-md",
} as const;
const tones = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
  accent: "text-accent",
} as const;

/** Label-value-detail triplet of a widget or the hero strip (old `.fact .l .v .d`). */
export function Fact({
  label,
  value,
  detail,
  tone,
  size = "lg",
  title,
  tile = false,
  className = "",
}: FactProps) {
  if (tile)
    return (
      <div title={title} className={`tile-sub grid min-w-0 gap-0.5 px-3.5 py-3 ${className}`}>
        <div className="truncate text-xs text-fg-muted">{label}</div>
        <div
          className={`truncate text-lg font-heavy tracking-heading tabular-nums ${tone ? tones[tone] : ""}`}
        >
          {value}
        </div>
        {detail != null && detail !== "" && (
          <div className="truncate text-2xs-plus text-fg-muted">{detail}</div>
        )}
      </div>
    );
  return (
    <div title={title} className={`min-w-0 ${className}`}>
      <div
        className={`text-2xs uppercase text-fg-muted ${size === "xl" ? "tracking-caps" : "tracking-label"}`}
      >
        {label}
      </div>
      <div
        className={`font-heavy tracking-snug tabular-nums ${sizes[size]} ${tone ? tones[tone] : ""}`}
      >
        {value}
      </div>
      {detail != null && detail !== "" && (
        <div className={`text-xs text-fg-muted ${size === "xl" ? "mt-0.5" : "mt-px"}`}>
          {detail}
        </div>
      )}
    </div>
  );
}

export interface FactsProps {
  items: readonly FactProps[];
  /** Number of equal columns (default 2). */
  columns?: number;
  /** Every fact as a layered sub-tile (`Fact` `tile`), 10px apart. */
  tile?: boolean;
  /** Layout only (margin). */
  className?: string;
}

/** Facts in a grid of equal columns (old `.facts`, 12px / 18px gaps). */
export function Facts({ items, columns = 2, tile = false, className = "" }: FactsProps) {
  return (
    <div
      className={`grid ${tile ? "gap-2.5" : "gap-x-4.5 gap-y-3"} ${className}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: facts are a fixed, ordered list without ids.
        <Fact key={index} tile={tile} {...fact} />
      ))}
    </div>
  );
}
