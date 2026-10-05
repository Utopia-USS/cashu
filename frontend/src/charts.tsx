// SVG charts of the v2 widgets (design/v2/v2.js behaviour): line chart with benchmark, level lines, end
// labels with leaders and a hover / keyboard crosshair with a tooltip; bars with a plan line; donut with
// surface gaps; sparkline. Colours come from CSS classes on the tokens (index.css `.chart`, `.spark`), so a
// theme switch needs no re-render. The SVG is drawn at the measured pixel width: text keeps its size.
import { type ReactNode, useState } from "react";
import { areaPath, bandPath, barLayout, donutArcs, extent, linePath, linear, nearestIndex, type Pt, sparkline, stackLabels, stackLayers, ticks } from "./chart";
import { useWidth } from "./hooks";

/** 30-day style sparkline (72 x 22). `tone` overrides the first-vs-last colour ("" = muted). */
export function Spark({ values, tone, label }: { values: (number | null | undefined)[]; tone?: "pos" | "neg" | ""; label?: string }) {
  const g = sparkline(values);
  if (!g.d) return <span className="spark" aria-hidden />;
  const cls = tone ?? (g.tone === "flat" ? "" : g.tone);
  return (
    <span className="spark" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <svg viewBox="0 0 72 22" preserveAspectRatio="none">
        <path d={g.d} className={cls} />
        {g.last && <circle cx={g.last[0]} cy={g.last[1]} r={2} />}
      </svg>
    </span>
  );
}

export interface LineSeries {
  values: (number | null)[]; cls: "main" | "bench" | "neg"; area?: boolean; endLabel?: string;
  /** Area baseline value (default: the bottom of the plot); 0 for a drawdown filled up to the zero line. */
  areaTo?: number;
}
export interface Level { y: number; cls: "alert" | "rule" | "cost" | "agent"; label?: string; muted?: boolean }

const DOT: Record<LineSeries["cls"], string> = { main: "var(--nw)", bench: "var(--bench)", neg: "var(--neg)" };

/** Line chart. x = index (evenly sampled series); `xLabels` place date labels by index. */
export function LineChart({
  series, levels = [], xLabels = [], yFmt, yTicks = 4, ymin, ymax, height = 230, padL = 56, padR = 64, markers = [], tooltip, label,
}: {
  series: LineSeries[];
  levels?: Level[];
  xLabels?: { i: number; text: string }[];
  /** Y axis label formatter; `false` hides the axis labels (padL shrinks to 6). */
  yFmt?: ((v: number) => string) | false;
  yTicks?: number;
  ymin?: number;
  ymax?: number;
  height?: number;
  padL?: number;
  padR?: number;
  markers?: { i: number; cls: "buy" | "sell"; y?: number }[];
  /** Hover / keyboard tooltip content for a data index; omit for a static chart. */
  tooltip?: (i: number) => ReactNode;
  label: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const w = Math.max(width, 120), h = height;
  const left = yFmt === false ? 6 : padL, padT = 10, padB = 22;
  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null)).concat(levels.map((l) => l.y));
  const [lo, hi] = extent(all, { ymin, ymax });
  const X = linear(0, Math.max(1, n - 1), left, w - padR);
  const Y = linear(lo, hi, h - padB, padT);
  const lastOf = (s: LineSeries) => {
    for (let i = s.values.length - 1; i >= 0; i--) if (s.values[i] != null) return i;
    return -1;
  };
  const ends = series.filter((s) => s.endLabel && lastOf(s) >= 0).map((s) => ({ s, i: lastOf(s), y: Y(s.values[lastOf(s)]!) , right: false }));
  const rightLevels = levels.filter((l) => l.label).map((l) => ({ l, y: Y(l.y), right: true }));
  const stacked = stackLabels([...ends, ...rightLevels], 13, h - padB);
  const tickVals = ticks(lo, hi, yTicks);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!tooltip || n < 2) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * w;
    setHover(nearestIndex(px, n, left, w - padR));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!tooltip || n < 2) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((cur) => Math.max(0, Math.min(n - 1, (cur ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Escape") setHover(null);
  };
  const hx = hover != null ? X(hover) : 0;
  const tipY = hover != null ? Math.min(...series.map((s) => (s.values[hover] != null ? Y(s.values[hover]!) : h)).filter(Number.isFinite)) : 0;
  return (
    <div className="chart" ref={ref} style={{ height: h }} tabIndex={tooltip ? 0 : undefined} onKeyDown={onKey}
      onBlur={() => setHover(null)} aria-label={label} role="img">
      {width > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {tickVals.map((v, k) => (
            <g key={k}>
              <line className="gl" x1={left} x2={w - padR + 6} y1={Y(v)} y2={Y(v)} />
              {yFmt !== false && <text className="ax" x={left - 8} y={Y(v) + 3.5} textAnchor="end">{(yFmt ?? String)(v)}</text>}
            </g>
          ))}
          {xLabels.map((xl, k) => (
            <text key={k} className="ax" x={X(xl.i)} y={h - 6}
              textAnchor={k === 0 && xl.i === 0 ? "start" : xl.i === n - 1 ? "end" : "middle"}>{xl.text}</text>
          ))}
          {levels.map((l, k) => <line key={k} className={`lvl ${l.cls}`} x1={left} x2={w - padR + 6} y1={Y(l.y)} y2={Y(l.y)} />)}
          {series.map((s, k) => {
            const pts = s.values.map((v, i) => (v == null ? null : ([X(i), Y(v)] as Pt)));
            const solid = pts.filter((p): p is Pt => p != null);
            return (
              <g key={k}>
                {s.area && solid.length > 1 && <path className={`area ${s.cls}`} d={areaPath(solid, Y(Math.max(lo, Math.min(hi, s.areaTo ?? lo))))} />}
                <path className={`ln ${s.cls}`} d={linePath(pts)} />
              </g>
            );
          })}
          {markers.map((m, k) => {
            const v = m.y ?? series[0]?.values[m.i];
            return v == null ? null : <circle key={k} className={`mk ${m.cls}`} cx={X(m.i)} cy={Y(v)} r={4} />;
          })}
          {stacked.map((it, k) => {
            if ("s" in it) {
              const x = X(it.i);
              return (
                <g key={`e${k}`}>
                  <circle className="mk" cx={x} cy={it.y} r={3.5} style={{ fill: DOT[it.s.cls] }} />
                  {Math.abs(it.ly - it.y) > 1 && <line className="gl" style={{ stroke: "var(--bench)" }} x1={x + 4} y1={it.y} x2={x + 9} y2={it.ly} />}
                  <text className={`lbl ${it.s.cls === "bench" ? "muted" : ""}`} x={x + 11} y={it.ly + 3.5}>{it.s.endLabel}</text>
                </g>
              );
            }
            const x0 = w - padR + 6;
            return (
              <g key={`l${k}`}>
                {Math.abs(it.ly - it.y) > 1 && <line className="gl" style={{ stroke: "var(--bench)" }} x1={x0} y1={it.y} x2={x0 + 6} y2={it.ly} />}
                <text className={`lbl ${it.l.muted ? "muted" : ""}`} x={x0 + 9} y={it.ly + 3.5}>{it.l.label}</text>
              </g>
            );
          })}
          {hover != null && (
            <g>
              <line className="cross" x1={hx} x2={hx} y1={padT} y2={h - padB} />
              {series.map((s, k) => s.values[hover] != null && (
                <circle key={k} className="mk" cx={hx} cy={Y(s.values[hover]!)} r={3.5} style={{ fill: DOT[s.cls] }} />
              ))}
            </g>
          )}
        </svg>
      )}
      {hover != null && tooltip && width > 0 && (
        <div className="tip" role="status" style={{
          left: hx, top: Math.max(0, tipY - 8),
          transform: `translate(${hx > w * 0.6 ? "-108%" : "10px"}, -100%)`,
        }}>{tooltip(hover)}</div>
      )}
    </div>
  );
}

/** Monthly bars with an optional dashed plan line (label on the left) and value labels. */
export function Bars({ values, labels, plan, planLabel, cls, valueLabels, height = 120, label }: {
  values: number[];
  labels?: (string | null)[];
  plan?: number | null;
  planLabel?: string;
  /** Per-bar class: "main" (default), "plan" (planned, not done), "mutedbar". */
  cls?: (string | null | undefined)[];
  valueLabels?: (string | null)[];
  height?: number;
  label: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const w = Math.max(width, 120), h = height;
  const { boxes, y } = barLayout(values.map((v, i) => (cls?.[i] === "plan" && plan ? plan : v)), w, h, { plan });
  return (
    <div className="chart" ref={ref} style={{ height: h }} role="img" aria-label={label}>
      {width > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
          <line className="gl" x1={0} x2={w} y1={y(0)} y2={y(0)} />
          {boxes.map((b, i) => (
            <g key={i}>
              {b.h > 0 && <rect className={`bx ${cls?.[i] || "main"}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={3} />}
              {labels?.[i] != null && <text className="ax" x={b.cx} y={h - 4} textAnchor="middle">{labels[i]}</text>}
              {valueLabels?.[i] != null && b.h > 0 && <text className="lbl" x={b.cx} y={b.y - 4} textAnchor="middle">{valueLabels[i]}</text>}
            </g>
          ))}
          {plan ? (
            <g>
              <line className="lvl rule" x1={0} x2={w} y1={y(plan)} y2={y(plan)} />
              <text className="lbl muted" x={2} y={y(plan) - 4}>{planLabel ?? "plan"}</text>
            </g>
          ) : null}
        </svg>
      )}
    </div>
  );
}

/** Donut with 2 px surface gaps; `children` is the centre text. */
export function Donut({ segments, size = 112, label, children }: {
  segments: { value: number; color: string }[]; size?: number; label: string; children?: ReactNode;
}) {
  const arcs = donutArcs(segments.map((s) => s.value), size);
  return (
    <div className="donut" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {arcs.map((d, i) => d && <path key={i} d={d} fill={segments[i].color} fillRule="evenodd" />)}
      </svg>
      {children && <div className="c">{children}</div>}
    </div>
  );
}

/** Stacked areas (assets up from 0, liabilities down) with the total as the one line; hover tooltip. */
export function StackedChart({ rows, keys, colors, totals, xLabels = [], yFmt, height = 230, padL = 60, padR = 16, tooltip, label }: {
  rows: Record<string, number>[];
  keys: string[];
  colors: Record<string, string>;
  totals: number[];
  xLabels?: { i: number; text: string }[];
  yFmt: (v: number) => string;
  height?: number;
  padL?: number;
  padR?: number;
  tooltip?: (i: number) => ReactNode;
  label: string;
}) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const n = rows.length, w = Math.max(width, 120), h = height, padT = 10, padB = 22;
  const { layers, min, max } = stackLayers(rows, keys);
  const [lo, hi] = extent([min, max, ...totals]);
  const X = linear(0, Math.max(1, n - 1), padL, w - padR);
  const Y = linear(lo, hi, h - padB, padT);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!tooltip || n < 2) return;
    const box = e.currentTarget.getBoundingClientRect();
    setHover(nearestIndex(((e.clientX - box.left) / box.width) * w, n, padL, w - padR));
  };
  const hx = hover != null ? X(hover) : 0;
  return (
    <div className="chart" ref={ref} style={{ height: h }} role="img" aria-label={label} tabIndex={tooltip ? 0 : undefined}
      onKeyDown={(e) => {
        if (!tooltip || n < 2 || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
        e.preventDefault();
        setHover((c) => Math.max(0, Math.min(n - 1, (c ?? n - 1) + (e.key === "ArrowRight" ? 1 : -1))));
      }} onBlur={() => setHover(null)}>
      {width > 0 && (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {ticks(lo, hi, 4).map((v, k) => (
            <g key={k}>
              <line className="gl" x1={padL} x2={w - padR} y1={Y(v)} y2={Y(v)} />
              <text className="ax" x={padL - 8} y={Y(v) + 3.5} textAnchor="end">{yFmt(v)}</text>
            </g>
          ))}
          {xLabels.map((xl, k) => (
            <text key={k} className="ax" x={X(xl.i)} y={h - 6} textAnchor={xl.i === 0 ? "start" : xl.i === n - 1 ? "end" : "middle"}>{xl.text}</text>
          ))}
          {layers.map((l) => (
            <path key={l.key} className="stk" style={{ fill: colors[l.key] ?? "var(--nw)" }}
              d={bandPath(l.hi.map((v, i) => [X(i), Y(v)] as Pt), l.lo.map((v, i) => [X(i), Y(v)] as Pt))} />
          ))}
          <path className="ln" style={{ stroke: "var(--text)", strokeWidth: 1.75 }} d={linePath(totals.map((v, i) => [X(i), Y(v)] as Pt))} />
          {hover != null && <line className="cross" x1={hx} x2={hx} y1={padT} y2={h - padB} />}
        </svg>
      )}
      {hover != null && tooltip && width > 0 && (
        <div className="tip" role="status" style={{ left: hx, top: padT, transform: `translate(${hx > w * 0.6 ? "-108%" : "10px"}, 0)` }}>{tooltip(hover)}</div>
      )}
    </div>
  );
}
