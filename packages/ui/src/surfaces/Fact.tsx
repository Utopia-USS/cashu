import type { ReactNode } from "react";

export interface FactProps {
  /** Uppercase caption above the value. */
  label: ReactNode;
  value: ReactNode;
  /** Muted line under the value; omitted when null or empty. */
  detail?: ReactNode;
  /** Colour of the value. */
  tone?: "positive" | "negative" | "warning";
  /** Value size: `lg` 17px (default), `md` 16px (hero strip), `sm` 14px. */
  size?: "lg" | "md" | "sm";
  /** Tooltip of the whole fact. */
  title?: string;
  /** Layout only (padding and dividers of a strip, grid placement). */
  className?: string;
}

const sizes = { lg: "text-lg", md: "text-base-plus", sm: "text-md" } as const;
const tones = {
  positive: "text-positive",
  negative: "text-negative",
  warning: "text-warning",
} as const;

/** Label-value-detail triplet of a widget or the hero strip (old `.fact .l .v .d`). */
export function Fact({
  label,
  value,
  detail,
  tone,
  size = "lg",
  title,
  className = "",
}: FactProps) {
  return (
    <div title={title} className={`min-w-0 ${className}`}>
      <div className="text-2xs uppercase tracking-label text-fg-muted">{label}</div>
      <div
        className={`mt-px font-heavy tracking-snug tabular-nums ${sizes[size]} ${tone ? tones[tone] : ""}`}
      >
        {value}
      </div>
      {detail != null && detail !== "" && (
        <div className="mt-px text-xs text-fg-muted">{detail}</div>
      )}
    </div>
  );
}

export interface FactsProps {
  items: readonly FactProps[];
  /** Number of equal columns (default 2). */
  columns?: number;
  /** Layout only (margin). */
  className?: string;
}

/** Facts in a grid of equal columns (old `.facts`, 12px / 18px gaps). */
export function Facts({ items, columns = 2, className = "" }: FactsProps) {
  return (
    <div
      className={`grid gap-x-4.5 gap-y-3 ${className}`}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {items.map((fact, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: facts are a fixed, ordered list without ids.
        <Fact key={index} {...fact} />
      ))}
    </div>
  );
}
