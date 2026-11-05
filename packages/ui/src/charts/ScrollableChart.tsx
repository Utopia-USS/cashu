import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Seg } from "../controls/Seg.js";
import { useUiEnv } from "../environment/UiEnv.js";
import { Skeleton } from "../feedback/Skeleton.js";
import { ChartCard } from "../surfaces/ChartCard.js";
import { ChartFrame } from "./platform.js";
import {
  SCROLL,
  type ScrollSeries,
  scrollAxisScene,
  scrollPlotScene,
  scrollTicks,
} from "./scrollScene.js";
import type { ChartTip } from "./types.js";
import { maskTip } from "./values.js";

export interface ScrollableChartProps {
  /** The card head (old `.controls strong`). */
  title: ReactNode;
  /** Accessible name of the plot; the summary of its values follows it. */
  label: string;
  /** Controls left of the range switch (currency switch, aggregation select). */
  controls?: ReactNode;
  /** The range switch: [label, visible periods] (null = everything, no scroll). */
  ranges: readonly (readonly [string, number | null])[];
  range: number | null;
  onRangeChange(range: number | null): void;
  /** One category per period (x axis). */
  labels: readonly string[];
  /** Grouped bars per category, in drawing order. */
  bars: readonly ScrollSeries[];
  /** A monotone line with dots over the bars (the net result). */
  line?: ScrollSeries;
  /** Y axis label of a value (masks amounts itself in privacy mode). */
  yFormat(v: number): string;
  /** Tooltip of a category; `amount` rows are masked in privacy mode. */
  tooltip?: (i: number) => ChartTip;
  /** Screen-reader summary of the values (already privacy-safe). */
  summary?: string;
  /** Shown instead of the skeleton when there is no data. */
  emptyText?: string;
  /** Layout only. */
  className?: string;
}

/** Card with a fixed Y axis and a horizontally scrollable plot (old components/ScrollableChart.tsx): the range
 * switch sets the visible window, the plot is scaled so the window fills the box and the rest scrolls; a range
 * or data change jumps to the newest edge, a resize keeps the centred period in view. */
export function ScrollableChart(props: ScrollableChartProps) {
  const { privacy } = useUiEnv();
  const { labels, range, tooltip } = props;
  const box = useRef<HTMLDivElement>(null);
  const [boxWidth, setBoxWidth] = useState(0);
  const full = labels.length;
  const hasData = full > 0;
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setBoxWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasData]);
  const width = boxWidth || 320;
  const windowSpan = range == null ? full : Math.min(range, full || range);
  const ratio = windowSpan > 0 ? full / windowSpan : 1;
  const plotWidth = Math.min(SCROLL.maxWidth, Math.max(width, Math.round(width * ratio)));

  const centre = useRef(1);
  const prev = useRef({ range, n: full });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const jumped = prev.current.range !== range || prev.current.n !== full;
    prev.current = { range, n: full };
    const max = el.scrollWidth - el.clientWidth;
    if (jumped) {
      el.scrollLeft = max;
      centre.current = 1;
    } else
      el.scrollLeft = Math.max(
        0,
        Math.min(max, centre.current * el.scrollWidth - el.clientWidth / 2),
      );
  }, [plotWidth, range, full]);
  const onScroll = () => {
    const el = box.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    centre.current = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
  };

  const data = { labels, bars: props.bars, line: props.line };
  const ticks = scrollTicks(data);
  return (
    <ChartCard
      title={props.title}
      className={props.className}
      controls={
        <>
          {props.controls}
          <Seg items={props.ranges} value={range} onChange={props.onRangeChange} />
        </>
      }
    >
      {!full ? (
        props.emptyText ? (
          <div className="flex h-35 items-center justify-center px-5 py-7 text-center text-md text-fg-muted">
            {props.emptyText}
          </div>
        ) : (
          <Skeleton height={SCROLL.height} />
        )
      ) : (
        <div className="flex h-78.5 items-stretch">
          <div className="w-18 flex-none">
            <ChartFrame
              width={SCROLL.axisWidth}
              height={SCROLL.height}
              label={props.label}
              decorative
              build={() => scrollAxisScene(ticks, props.yFormat)}
            />
          </div>
          <div
            ref={box}
            onScroll={onScroll}
            className="min-w-0 flex-auto overflow-x-auto overflow-y-hidden [scrollbar-color:var(--color-border)_transparent] [scrollbar-width:thin]"
          >
            <ChartFrame
              width={plotWidth}
              height={SCROLL.height}
              label={props.label}
              tooltip={tooltip ? (i) => maskTip(tooltip(i), privacy) : undefined}
              build={(w) =>
                scrollPlotScene(
                  data,
                  w,
                  ticks,
                  `${props.label}: ${props.summary ?? ""}`,
                  tooltip != null,
                )
              }
            />
          </div>
        </div>
      )}
    </ChartCard>
  );
}
