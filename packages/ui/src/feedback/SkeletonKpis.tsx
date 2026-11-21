import { Skeleton } from "./Skeleton.js";

export interface SkeletonKpisProps {
  /** Placeholder cards (default 6). */
  n?: number;
}

/** Loading placeholder of a figure row (old ui.tsx `SkeletonKpis`): `.kpis` of `.card.kpi` cards, each a 90x10
 * label bar, a 130x22 value bar and a 70x10 hint bar, 8px apart. */
export function SkeletonKpis({ n = 6 }: SkeletonKpisProps) {
  return (
    <div
      className="mb-5 grid gap-3"
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      {Array.from({ length: n }, (_, i) => `kpi${i}`).map((key) => (
        <div
          key={key}
          className="rounded-widget border border-border bg-surface-raised px-4.5 py-4"
        >
          <Skeleton width={90} height={10} />
          <Skeleton width={130} height={22} className="mt-2" />
          <Skeleton width={70} height={10} className="mt-2" />
        </div>
      ))}
    </div>
  );
}
