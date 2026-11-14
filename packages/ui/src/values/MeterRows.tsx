import type { ReactNode } from "react";

export type MeterTone = "accent" | "positive" | "negative" | "muted";

export interface MeterRow {
  key: string;
  label: ReactNode;
  /** Bar fill in percent of the track (0-100). */
  fill: number;
  /** Fill colour (default muted). */
  tone?: MeterTone;
  /** The formatted value right of the bar. */
  value: ReactNode;
  /** Colour of the value text. */
  valueTone?: "positive" | "negative";
}

export interface MeterRowsProps {
  rows: readonly MeterRow[];
  /** Layout only (margin). */
  className?: string;
}

const fills = {
  accent: "bg-accent",
  positive: "bg-positive",
  negative: "bg-negative",
  muted: "bg-fg-muted",
} as const;
const valueTones = { positive: "text-positive", negative: "text-negative" } as const;

/** Label | bar | value rows (old `.bud`: 86px muted key, an 8px chip track with a rounded fill, a 96px
 * right-aligned tabular value; 12.5px, gaps 6px 10px), e.g. income / spending / surplus of a month. */
export function MeterRows({ rows, className = "" }: MeterRowsProps) {
  return (
    <div
      className={`grid grid-cols-[86px_minmax(0,1fr)_96px] items-center gap-x-2.5 gap-y-1.5 text-xs-plus ${className}`}
    >
      {rows.map((row) => (
        <MeterCells key={row.key} row={row} />
      ))}
    </div>
  );
}

function MeterCells({ row }: { row: MeterRow }) {
  return (
    <>
      <span className="text-fg-muted">{row.label}</span>
      <span className="relative h-2 overflow-hidden rounded-2xs bg-chip">
        <i
          className={`absolute inset-y-0 left-0 rounded-2xs ${fills[row.tone ?? "muted"]}`}
          style={{ width: `${Math.max(0, Math.min(100, row.fill))}%` }}
        />
      </span>
      <span
        className={`whitespace-nowrap text-right tabular-nums ${row.valueTone ? valueTones[row.valueTone] : ""}`}
      >
        {row.value}
      </span>
    </>
  );
}
