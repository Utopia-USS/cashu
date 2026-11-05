/** `.wbar` + the percentage of a `td.wcell`: a 56 x 5 bar, the fill relative to the largest weight. */
export interface WeightBarProps {
  fill: number;
  text: string;
}

export function WeightBar({ fill, text }: WeightBarProps) {
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
