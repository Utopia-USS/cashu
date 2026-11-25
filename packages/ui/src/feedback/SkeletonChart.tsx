import { Skeleton } from "./Skeleton.js";

export interface SkeletonChartProps {
  /** Height of the chart block in px (default 300). */
  height?: number;
}

/** Loading placeholder of a chart card (old ui.tsx `SkeletonChart`): the `.card.chart-card` frame with a 180x14
 * title bar 14px above a full-width block. */
export function SkeletonChart({ height = 300 }: SkeletonChartProps) {
  return (
    <div className="mb-4.5 rounded-widget border border-border bg-surface-raised px-4.5 py-4">
      <Skeleton width={180} height={14} className="mb-3.5" />
      <Skeleton height={height} />
    </div>
  );
}
