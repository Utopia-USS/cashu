import { Skeleton } from "./Skeleton.js";

export interface SkeletonTableProps {
  /** Placeholder rows (default 6). */
  rows?: number;
  /** A title bar above the rows (default true). */
  title?: boolean;
}

/** Loading placeholder of a table card (old ui.tsx `SkeletonTable`): the `.card.chart-card` frame, a 160x14
 * title bar 14px above the rows, each row a 40 % bar and an 80px bar at the ends (9px padding, rule below). */
export function SkeletonTable({ rows = 6, title = true }: SkeletonTableProps) {
  return (
    <div className="mb-4.5 rounded-widget border border-border bg-surface-raised px-4.5 py-4">
      {title && <Skeleton width={160} height={14} className="mb-3.5" />}
      {Array.from({ length: rows }, (_, i) => `row${i}`).map((key) => (
        <div key={key} className="flex items-center gap-3 border-b border-border py-2.25">
          <Skeleton width="40%" height={12} />
          <span className="flex-1" />
          <Skeleton width={80} height={12} />
        </div>
      ))}
    </div>
  );
}
