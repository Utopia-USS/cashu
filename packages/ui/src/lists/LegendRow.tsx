import type { ReactNode } from "react";
import { Swatch } from "../charts/Swatch.js";
import type { ChartColor } from "../charts/scene.js";

export interface LegendRowProps {
  /** Colour key in the first 16px column; without it the row has no swatch column (old `.mc-all .legend-row`). */
  swatch?: ChartColor;
  label: ReactNode;
  /** Formatted amount (120px column). */
  amount: ReactNode;
  /** Formatted share ("12%", 46px column, muted). */
  share: ReactNode;
  /** Makes the row a button with the old `.clickable` hover (chip fill). */
  onPress?: () => void;
  /** Whether the rows this one discloses are shown (the "Reszta" row). */
  expanded?: boolean;
}

const grid = "grid items-center gap-2.5 py-1 text-md";
const cols = (swatch: boolean) =>
  swatch
    ? "grid-cols-[--spacing(4)_minmax(0,1fr)_--spacing(30)_--spacing(11.5)]"
    : "grid-cols-[minmax(0,1fr)_--spacing(30)_--spacing(11.5)]";

/** One category of a spending legend (old `.legend-row`: swatch, label, amount, share; 4px rows, 14px). */
export function LegendRow({ swatch, label, amount, share, onPress, expanded }: LegendRowProps) {
  const cells = (
    <>
      {swatch !== undefined && <Swatch color={swatch} size="lg" />}
      <span className="text-fg">{label}</span>
      <span className="tabular-nums text-fg">{amount}</span>
      <span className="tabular-nums text-fg-muted">{share}</span>
    </>
  );
  const cls = `${grid} ${cols(swatch !== undefined)}`;
  return onPress ? (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onPress}
      className={`${cls} w-full cursor-pointer border-0 bg-transparent px-0 text-left hover:bg-chip`}
    >
      {cells}
    </button>
  ) : (
    <div className={cls}>{cells}</div>
  );
}
