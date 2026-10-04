import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CartesianGrid, ComposedChart, XAxis, YAxis } from "recharts";
import { isDark } from "../core/theme";
import { cssVar, pln0 } from "../format";
import { useWidth } from "../hooks";
import { Seg, Skeleton } from "../ui";

const MAX_W = 24000;
const MAX_Y_ZOOM = 60;
const H = 300;
const XAXIS_H = 24;
const AXIS_W = 72;
const M_TOP = 8, M_BOTTOM = 4, M_RIGHT = 16;
const PLOT_H = H - M_TOP - M_BOTTOM - XAXIS_H;

const gridColor = () => (isDark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.10)");

function niceTicks(min: number, max: number, count = 5): number[] {
  if (!isFinite(min) || !isFinite(max)) return [0, 1];
  if (min === max) return [min, min + 1];
  const rawStep = (max - min) / (count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)));
  const norm = rawStep / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 0.5; v += step) ticks.push(Math.round(v));
  return ticks;
}

export interface ScrollableChartProps {
  title: ReactNode;
  controls?: ReactNode;               // extra controls left of the range switch
  data: object[];
  yValues: number[];                  // drives the shared domain + ticks
  yTickFormatter?: (v: number) => string;
  xAxisProps: Record<string, unknown>; // dataKey/type/scale/domain/tickFormatter/minTickGap…
  ranges: [string, number | null][];  // [label, windowSpan] — null = Max (fit, no scroll)
  fullSpan: number;                   // total x extent (same unit as windowSpan)
  defaultRange?: number | null;
  tooltip?: ReactNode;                // a <Tooltip/> element (plot only)
  stackOffset?: "none" | "sign" | "expand" | "wiggle" | "silhouette";
  yZoomable?: boolean;                // enable Y-axis zoom (⌘+scroll / pinch)
  emptyText?: string;                 // shown instead of the skeleton once loaded with no data
  children: ReactNode;                // marks: <Line/> / <Bar/> …
}

/** Fixed y-axis + horizontally-scrollable plot. The range switch sets the visible
 * WINDOW; the plot is scaled so the window fills the viewport and the rest scrolls.
 * "Max" fits everything (no scroll). Gridlines are drawn explicitly from the shared
 * ticks so they stay aligned with the fixed axis. */
export function ScrollableChart(props: ScrollableChartProps) {
  const { title, controls, data, yValues, xAxisProps, ranges, fullSpan, tooltip, stackOffset, yZoomable, emptyText, children } = props;
  const yTickFormatter = props.yTickFormatter ?? ((v: number) => pln0.format(v));
  const [range, setRange] = useState<number | null>(props.defaultRange ?? null);
  const { ref: scrollRef, width: boxWidth, node: scrollNode } = useWidth<HTMLDivElement>();

  // Full ("home") Y domain from the data, and an optional user-zoomed window.
  const baseTicks = useMemo(() => {
    if (!yValues.length) return [0, 1];
    return niceTicks(Math.min(...yValues), Math.max(...yValues), 5);
  }, [yValues]);
  const baseDomain: [number, number] = [baseTicks[0], baseTicks[baseTicks.length - 1]];
  const [yView, setYView] = useState<[number, number] | null>(null);

  // Reset the zoom whenever the underlying data domain changes (scope / range / mode).
  useEffect(() => { setYView(null); }, [baseDomain[0], baseDomain[1]]);

  const yDomain: [number, number] = yView ?? baseDomain;
  const ticks = useMemo(() => {
    if (!yView) return baseTicks;
    const t = niceTicks(yView[0], yView[1], 5);
    const eps = (yView[1] - yView[0]) * 1e-6;
    return t.filter((v) => v >= yView[0] - eps && v <= yView[1] + eps);
  }, [yView, baseTicks]);

  // ⌘/ctrl + wheel and trackpad pinch (both arrive as a modified wheel event)
  // zoom the Y domain around the cursor. A plain vertical wheel PANS the zoomed
  // window (nothing to pan when not zoomed → the page scrolls as usual).
  const baseDomainRef = useRef(baseDomain);
  baseDomainRef.current = baseDomain;
  const yViewRef = useRef(yView);
  yViewRef.current = yView;
  useEffect(() => {
    const el = scrollNode.current;
    if (!el || !yZoomable) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const frac = Math.min(1, Math.max(0, (e.clientY - rect.top - M_TOP) / PLOT_H));
        setYView((prev) => {
          const [bLo, bHi] = baseDomainRef.current;
          const full = bHi - bLo || 1;
          const [lo, hi] = prev ?? [bLo, bHi];
          const span = hi - lo;
          const vCursor = hi - frac * span; // data value under the pointer
          // Pinch arrives as ctrl+wheel with smaller deltas than ⌘+scroll → zoom faster.
          const k = e.ctrlKey ? 0.004 : 0.0015;
          let newSpan = span * Math.exp(e.deltaY * k);
          newSpan = Math.min(full, Math.max(full / MAX_Y_ZOOM, newSpan));
          if (newSpan >= full) return null; // zoomed all the way out → home
          let newHi = vCursor + frac * newSpan;
          let newLo = newHi - newSpan;
          if (newHi > bHi) { newHi = bHi; newLo = bHi - newSpan; }
          if (newLo < bLo) { newLo = bLo; newHi = bLo + newSpan; }
          return [newLo, newHi];
        });
        return;
      }
      // Plain wheel: pan vertically only while zoomed and the gesture is vertical
      // (leave horizontal scroll of the plot, and page scroll when unzoomed, alone).
      if (yViewRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        e.preventDefault();
        setYView((prev) => {
          if (!prev) return prev;
          const [bLo, bHi] = baseDomainRef.current;
          const [lo, hi] = prev;
          const span = hi - lo;
          const shift = e.deltaY * (span / PLOT_H); // scroll down → window moves to lower values
          let nLo = lo - shift, nHi = hi - shift;
          if (nLo < bLo) { nLo = bLo; nHi = bLo + span; }
          if (nHi > bHi) { nHi = bHi; nLo = bHi - span; }
          return [nLo, nHi];
        });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [yZoomable, boxWidth]);

  const box = boxWidth || 320;
  const windowSpan = range == null ? fullSpan : Math.min(range, fullSpan || range);
  const ratio = windowSpan > 0 ? fullSpan / windowSpan : 1;
  const plotWidth = Math.min(MAX_W, Math.max(box, Math.round(box * ratio)));

  // Scroll anchoring: on range/data change jump to the most-recent edge; on a
  // window resize keep the currently-centred date in view (clamped to edges).
  const centerFrac = useRef(1); // 1 = right edge (most recent)
  const prevRange = useRef(range);
  const prevLen = useRef(data.length);

  const onScroll = () => {
    const el = scrollNode.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    centerFrac.current = (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth;
  };

  useLayoutEffect(() => {
    const el = scrollNode.current;
    if (!el) return;
    const jumped = prevRange.current !== range || prevLen.current !== data.length;
    prevRange.current = range;
    prevLen.current = data.length;
    const max = el.scrollWidth - el.clientWidth;
    if (jumped) {
      el.scrollLeft = max; // most-recent window
      centerFrac.current = 1;
    } else {
      el.scrollLeft = Math.max(0, Math.min(max, centerFrac.current * el.scrollWidth - el.clientWidth / 2));
    }
  }, [plotWidth, range, data.length]);

  const muted = cssVar("--muted");
  const span = yDomain[1] - yDomain[0] || 1;
  const gridY = ticks.map((t) => M_TOP + (1 - (t - yDomain[0]) / span) * PLOT_H);

  const yAxisCommon = { domain: yDomain, ticks, interval: 0 as const, allowDataOverflow: true };

  return (
    <div className="card chart-card">
      <div className="controls">
        <strong style={{ fontSize: 14 }}>{title}</strong>
        <span className="spacer" />
        {yZoomable && yView && (
          <button className="btn" title="Reset zoomu osi Y" onClick={() => setYView(null)}>
            ⤢ Reset Y
          </button>
        )}
        {controls}
        <Seg items={ranges} value={range} onChange={setRange} />
      </div>

      {!data.length ? (
        emptyText
          ? <div className="empty" style={{ height: 140, display: "flex", alignItems: "center", justifyContent: "center" }}>{emptyText}</div>
          : <Skeleton w="100%" h={H} />
      ) : (
      <div style={{ display: "flex", alignItems: "stretch", height: H + 14 }}>
        <div style={{ flex: "0 0 auto", width: AXIS_W }}>
          <ComposedChart width={AXIS_W} height={H} data={data} margin={{ top: M_TOP, right: 0, bottom: M_BOTTOM, left: 8 }}>
            <XAxis {...xAxisProps} height={XAXIS_H} tick={false} tickLine={false} axisLine={false} />
            <YAxis {...yAxisCommon} width={AXIS_W - 8} tickFormatter={(v) => yTickFormatter(v as number)} tick={{ fontSize: 11, fill: muted }} />
          </ComposedChart>
        </div>

        <div className="nw-scroll" ref={scrollRef} onScroll={onScroll} style={{ flex: "1 1 auto" }}>
          <ComposedChart width={plotWidth} height={H} data={data} stackOffset={stackOffset} margin={{ top: M_TOP, right: M_RIGHT, bottom: M_BOTTOM, left: 0 }}>
            <CartesianGrid stroke={gridColor()} vertical={false} horizontalPoints={gridY} />
            <XAxis {...xAxisProps} height={XAXIS_H} tick={{ fontSize: 11, fill: muted }} />
            <YAxis {...yAxisCommon} width={0} tick={false} tickLine={false} axisLine={false} />
            {tooltip}
            {children}
          </ComposedChart>
        </div>
      </div>
      )}
    </div>
  );
}
