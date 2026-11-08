/** `.wbar` + the percentage of a `td.wcell`: a 56 x 5 bar, the fill relative to the largest weight. */
export interface WeightBarProps {
  fill: number;
  text: string;
  /** Design V5 asset rows: the percentage over a small 40 x 3 bar, right-aligned (default: the bar before it). */
  stacked?: boolean;
}

export function WeightBar({ fill, text, stacked }: WeightBarProps) {
  if (stacked)
    return (
      <span className="inline-grid justify-items-end gap-1.5">
        <span>{text}</span>
        <span
          aria-hidden="true"
          className="relative block h-0.75 w-10 overflow-hidden rounded-full bg-chip"
        >
          <i
            className="absolute inset-y-0 left-0 rounded-full bg-fg-muted"
            style={{ width: `${fill}%` }}
          />
        </span>
      </span>
    );
  return (
    <>
      <span
        aria-hidden="true"
        className="relative mr-1.5 inline-block h-1.25 w-14 overflow-hidden rounded-3xs bg-chip align-middle"
      >
        <i
          className="absolute inset-y-0 left-0 rounded-3xs bg-fg-muted"
          style={{ width: `${fill}%` }}
        />
      </span>
      {text}
    </>
  );
}
