/// <reference lib="dom" />
import { useLayoutEffect, useRef, useState } from "react";

export interface SentimentBar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rising (positive), falling (negative) or an empty week (a 2px tick). */
  cls: "pos" | "neg" | "none";
}

export interface SentimentBarsProps {
  /** Accessible description of the eight weeks. */
  label: string;
  /** Week labels under the bars (a 13px band); absent: no band. */
  labels?: readonly string[];
  /** `sm` 56 x 18, `md` 128 x 30, `lg` the full width x 72. */
  size?: "sm" | "md" | "lg";
  /** Bar geometry for a drawing width, height and label band (ui-logic research `sentimentBars`). */
  layout(
    width: number,
    height: number,
    band: number,
  ): {
    mid: number;
    bars: readonly SentimentBar[];
    bw: number;
  };
}

const SIZES = { sm: [56, 18], md: [128, 30], lg: [0, 72] } as const;
const boxes = { sm: "h-4.5 w-14", md: "h-7.5 w-32", lg: "h-18 w-full" } as const;
const fills = { pos: "fill-positive", neg: "fill-negative", none: "fill-border" } as const;

/** Eight weekly sentiment bars, oldest left (old research `.sent`): positive rises, negative falls, an empty
 * week is a 2px tick; optional week labels under them. The `lg` size follows its own width. */
export function SentimentBars({ label, labels, size = "sm", layout }: SentimentBarsProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || size !== "lg") return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [size]);
  const [w0, h] = SIZES[size];
  const w = size === "lg" ? Math.max(120, Math.round(width) || 300) : w0;
  const band = labels ? 13 : 0;
  const { mid, bars, bw } = layout(w, h, band);
  return (
    <span
      ref={ref}
      role="img"
      aria-label={label}
      className={`inline-block flex-none align-middle ${boxes[size]}`}
    >
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width={size === "lg" ? undefined : w}
        height={h}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="block size-full overflow-visible"
      >
        <line x1={0} x2={w} y1={mid} y2={mid} className="stroke-border" strokeWidth={1} />
        {bars.map((b, i) => (
          <g key={`${b.x}`}>
            <rect
              x={b.x}
              y={b.y}
              width={b.w}
              height={b.h}
              rx={b.cls === "none" ? 0 : 1}
              className={fills[b.cls]}
            />
            {labels?.[i] && (
              <text
                x={b.x + bw / 2}
                y={h - 2}
                textAnchor="middle"
                className="fill-fg-muted text-3xs tabular-nums"
              >
                {labels[i]}
              </text>
            )}
          </g>
        ))}
      </svg>
    </span>
  );
}
