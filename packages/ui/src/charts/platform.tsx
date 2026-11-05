// Desktop renderer of the chart scenes: DOM <svg> (Electron renderer, Storybook). Colours are Tailwind
// classes of the theme (a theme switch needs no re-render), numbers in tabular figures. The frame owns the
// width (ResizeObserver), the hover / keyboard crosshair and the tooltip live region (F7 FE14 roles).
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import { layoutClass } from "../layout.js";
import { S } from "./charts.strings.js";
import { cls } from "./classes.js";
import { type ChartFrameProps, stepIndex } from "./frame.js";
import { nearestIndex } from "./geometry.js";
import { LOOK } from "./look.js";
import { type ChartRole, type Focus, ROLE_VAR, type Scene, type SceneNode } from "./scene.js";

const STROKE: Record<ChartRole, string> = {
  series1: "stroke-chart-1",
  series2: "stroke-chart-2",
  series3: "stroke-chart-3",
  series4: "stroke-chart-4",
  series5: "stroke-chart-5",
  series6: "stroke-chart-6",
  series7: "stroke-chart-7",
  series8: "stroke-chart-8",
  grid: "stroke-chart-grid",
  text: "stroke-fg",
  muted: "stroke-fg-muted",
  positive: "stroke-positive",
  negative: "stroke-negative",
  warning: "stroke-warning",
  info: "stroke-info",
  plan: "stroke-chip",
  surface: "stroke-surface-raised",
  axis: "stroke-chart-axis",
  rule: "stroke-chart-rule",
  paper: "stroke-on-accent",
  accent: "stroke-accent",
  net: "stroke-net",
  bench: "stroke-bench",
  "inv-global": "stroke-inv-global",
  "inv-pl": "stroke-inv-pl",
  "inv-bonds": "stroke-inv-bonds",
  "inv-cash": "stroke-inv-cash",
  "inv-other": "stroke-inv-other",
  "inv-5": "stroke-inv-5",
  "inv-6": "stroke-inv-6",
  "inv-7": "stroke-inv-7",
  "palette-1": "stroke-palette-1",
  "palette-2": "stroke-palette-2",
  "palette-3": "stroke-palette-3",
  "palette-4": "stroke-palette-4",
  "palette-5": "stroke-palette-5",
  "palette-6": "stroke-palette-6",
  "palette-7": "stroke-palette-7",
  "palette-8": "stroke-palette-8",
  "palette-9": "stroke-palette-9",
  "palette-10": "stroke-palette-10",
  "palette-11": "stroke-palette-11",
  "palette-12": "stroke-palette-12",
  "palette-13": "stroke-palette-13",
  "palette-14": "stroke-palette-14",
  "palette-15": "stroke-palette-15",
  "palette-16": "stroke-palette-16",
  "palette-17": "stroke-palette-17",
  "palette-18": "stroke-palette-18",
  "palette-19": "stroke-palette-19",
  "palette-20": "stroke-palette-20",
  "palette-21": "stroke-palette-21",
  "palette-22": "stroke-palette-22",
};

const FILL: Record<ChartRole, string> = {
  series1: "fill-chart-1",
  series2: "fill-chart-2",
  series3: "fill-chart-3",
  series4: "fill-chart-4",
  series5: "fill-chart-5",
  series6: "fill-chart-6",
  series7: "fill-chart-7",
  series8: "fill-chart-8",
  grid: "fill-chart-grid",
  text: "fill-fg",
  muted: "fill-fg-muted",
  positive: "fill-positive",
  negative: "fill-negative",
  warning: "fill-warning",
  info: "fill-info",
  plan: "fill-chip",
  surface: "fill-surface-raised",
  axis: "fill-chart-axis",
  rule: "fill-chart-rule",
  paper: "fill-on-accent",
  accent: "fill-accent",
  net: "fill-net",
  bench: "fill-bench",
  "inv-global": "fill-inv-global",
  "inv-pl": "fill-inv-pl",
  "inv-bonds": "fill-inv-bonds",
  "inv-cash": "fill-inv-cash",
  "inv-other": "fill-inv-other",
  "inv-5": "fill-inv-5",
  "inv-6": "fill-inv-6",
  "inv-7": "fill-inv-7",
  "palette-1": "fill-palette-1",
  "palette-2": "fill-palette-2",
  "palette-3": "fill-palette-3",
  "palette-4": "fill-palette-4",
  "palette-5": "fill-palette-5",
  "palette-6": "fill-palette-6",
  "palette-7": "fill-palette-7",
  "palette-8": "fill-palette-8",
  "palette-9": "fill-palette-9",
  "palette-10": "fill-palette-10",
  "palette-11": "fill-palette-11",
  "palette-12": "fill-palette-12",
  "palette-13": "fill-palette-13",
  "palette-14": "fill-palette-14",
  "palette-15": "fill-palette-15",
  "palette-16": "fill-palette-16",
  "palette-17": "fill-palette-17",
  "palette-18": "fill-palette-18",
  "palette-19": "fill-palette-19",
  "palette-20": "fill-palette-20",
  "palette-21": "fill-palette-21",
  "palette-22": "fill-palette-22",
};

function Node({
  node,
  prefix,
  onActivate,
}: {
  node: SceneNode;
  prefix: string;
  onActivate?: ((index: number) => void) | undefined;
}) {
  switch (node.k) {
    case "line":
      return (
        <line
          x1={node.x1}
          y1={node.y1}
          x2={node.x2}
          y2={node.y2}
          className={STROKE[node.stroke]}
          strokeWidth={node.width ?? 1}
          strokeDasharray={node.dash}
        />
      );
    case "path": {
      const gradient = typeof node.fill === "object" ? node.fill.gradient : null;
      const path = (
        <path
          d={node.d}
          className={cls(
            node.stroke && STROKE[node.stroke],
            node.fill == null ? "fill-none" : typeof node.fill === "string" && FILL[node.fill],
          )}
          fill={gradient ? `url(#${prefix}${gradient})` : undefined}
          fillRule={node.evenOdd ? "evenodd" : undefined}
          strokeWidth={node.stroke ? (node.width ?? 1) : undefined}
          strokeDasharray={node.dash}
          strokeLinejoin={node.stroke ? "round" : undefined}
          strokeLinecap={node.stroke ? (node.cap ?? "round") : undefined}
          opacity={node.opacity}
        />
      );
      if (!node.activation) return path;
      const activation = node.activation;
      return (
        // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot contain an HTML button; the arc has button semantics and full keyboard activation.
        <g
          role="button"
          tabIndex={0}
          aria-label={activation.label}
          className="cursor-pointer focus-visible:outline-2 focus-visible:outline-focus"
          onClick={() => onActivate?.(activation.index)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onActivate?.(activation.index);
            }
          }}
        >
          {path}
        </g>
      );
    }
    case "rect":
      return (
        <rect
          x={node.x}
          y={node.y}
          width={node.w}
          height={node.h}
          rx={node.rx}
          className={FILL[node.fill]}
          opacity={node.opacity}
        />
      );
    case "circle":
      return (
        <circle
          cx={node.cx}
          cy={node.cy}
          r={node.r}
          className={cls(
            FILL[node.fill],
            node.stroke ? STROKE[node.stroke] : node.ring && "stroke-surface-raised",
          )}
          strokeWidth={node.stroke ? (node.strokeWidth ?? 1) : node.ring ? 2 : undefined}
        />
      );
    case "text":
      return (
        <text
          x={node.x}
          y={node.y}
          textAnchor={node.anchor}
          className={cls(
            node.size === "md" ? LOOK.textMd : LOOK.text,
            node.tone === "muted" ? "fill-fg-muted" : "fill-fg",
          )}
        >
          {node.text}
        </text>
      );
  }
}

function SvgScene({
  scene,
  prefix,
  focus,
  label,
  onPointerMove,
  onPointerLeave,
  onActivate,
}: {
  scene: Scene;
  onActivate?: ((index: number) => void) | undefined;
  prefix: string;
  focus: Focus | null;
  /** The image's name when the frame is a group (interactive); otherwise the frame carries it. */
  label: string | null;
  onPointerMove?: (e: PointerEvent<SVGSVGElement>) => void;
  onPointerLeave?: () => void;
}) {
  const { width: w, height: h } = scene;
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="block overflow-visible"
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      role={label != null ? (onActivate ? "group" : "img") : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label == null ? true : undefined}
    >
      {scene.gradients.length > 0 && (
        <defs>
          {scene.gradients.map((g) => (
            <linearGradient
              key={g.id}
              id={`${prefix}${g.id}`}
              gradientUnits="userSpaceOnUse"
              x1={0}
              x2={0}
              y1={g.y1}
              y2={g.y2}
            >
              <stop
                offset={0}
                style={{ stopColor: `var(${ROLE_VAR[g.color]})`, stopOpacity: g.strong }}
              />
              <stop offset={1} style={{ stopColor: `var(${ROLE_VAR[g.color]})`, stopOpacity: 0 }} />
            </linearGradient>
          ))}
        </defs>
      )}
      {scene.nodes.map((node, k) => (
        // A scene is rebuilt whole; the node order is fixed per input, so the index is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: scene nodes have no identity beyond their order
        <Node key={k} node={node} prefix={prefix} onActivate={onActivate} />
      ))}
      {focus && (
        <g>
          <line
            x1={focus.x}
            x2={focus.x}
            y1={focus.top}
            y2={focus.bottom}
            className="stroke-fg-muted"
            strokeWidth={1}
            strokeDasharray="2 3"
          />
          {focus.dots.map((d) => (
            <circle
              key={`${d.fill}${d.cy}`}
              cx={focus.x}
              cy={d.cy}
              r={3.5}
              className={cls(FILL[d.fill], "stroke-surface-raised")}
              strokeWidth={2}
            />
          ))}
        </g>
      )}
    </svg>
  );
}

function useMeasuredWidth(fixed: number | undefined) {
  const ref = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (fixed != null || !el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setMeasured(Math.round(box.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  return { ref, width: fixed ?? measured };
}

/** A tooltip row's name with the space before its value (old `.tip`: "name <b>value</b>"). */
const spaced = (name: string): string => `${name} `;

/** Measures, draws and makes a chart scene interactive on the desktop. */
export function ChartFrame({
  width: fixed,
  height,
  layout,
  label,
  build,
  tooltip,
  center,
  decorative,
  inline,
  onActivate,
}: ChartFrameProps) {
  const { ref, width } = useMeasuredWidth(fixed);
  const [hover, setHover] = useState<number | null>(null);
  // A per-instance gradient id usable inside url(#...) (React's useId contains colons).
  const prefix = `g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const built = width > 0 ? build(width) : null;
  const scrub = tooltip && built?.scrub ? built.scrub : null;
  const summary = built?.summary || label;
  const focused = scrub && hover != null && hover < scrub.n ? hover : null;
  const focus = scrub && focused != null ? scrub.focus(focused) : null;
  const tip = tooltip && focused != null ? tooltip(focused) : null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!scrub) return;
    const delta = { ArrowRight: 1, ArrowLeft: -1, End: scrub.n, Home: -scrub.n }[e.key];
    if (delta != null) {
      e.preventDefault();
      setHover((cur) => stepIndex(cur, delta, scrub.n));
    } else if (e.key === "Escape") setHover(null);
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!scrub || !built) return;
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / (box.width || 1)) * built.scene.width;
    setHover(nearestIndex(px, scrub.n, scrub.x0, scrub.x1));
  };
  const roles = decorative
    ? { "aria-hidden": true }
    : scrub
      ? {
          role: "group",
          "aria-roledescription": S.chart,
          "aria-label": S.interactive(label),
          tabIndex: 0,
          onKeyDown,
          onBlur: () => setHover(null),
        }
      : { role: onActivate ? "group" : "img", "aria-label": summary };
  const right = focus != null && built != null && focus.x > built.scene.width * 0.6;

  return (
    <div
      ref={ref}
      className={cls(
        "relative",
        inline ? "inline-block align-middle" : "w-full",
        scrub != null && LOOK.focusRing,
        layoutClass(layout),
      )}
      style={{ height, width: fixed }}
      {...roles}
    >
      {built && (
        <SvgScene
          scene={built.scene}
          prefix={prefix}
          focus={focus}
          label={scrub || onActivate ? summary : null}
          onActivate={onActivate}
          onPointerMove={scrub ? onPointerMove : undefined}
          onPointerLeave={scrub ? () => setHover(null) : undefined}
        />
      )}
      {center && (
        <div className={LOOK.center} aria-hidden>
          <b className={LOOK.centerTitle}>{center.title}</b>
          {center.caption && <span className={LOOK.centerCaption}>{center.caption}</span>}
        </div>
      )}
      {/* The live region stays mounted (visually hidden while idle), so the first arrow press is announced. */}
      {scrub &&
        (tip && focus ? (
          <div
            role="status"
            className={LOOK.tip}
            style={{
              left: focus.x,
              top: focus.tipBelow ? focus.tipY : Math.max(0, focus.tipY - 8),
              // The old `.tip` offsets: 10 px right of the crosshair, or 108 % of its width left of it
              // past 60 % of the plot; above the focused point unless it hangs below the plot top.
              transform: `translate(${right ? "-108%" : "10px"}, ${focus.tipBelow ? "0" : "-100%"})`,
            }}
          >
            <div className="text-fg-muted">{tip.title}</div>
            {tip.rows.map((r) => (
              <div key={r.name} className={r.muted ? "text-fg-muted" : undefined}>
                {spaced(r.name)}
                <b className={LOOK.tipValue}>{r.value}</b>
              </div>
            ))}
          </div>
        ) : (
          <div role="status" className="sr-only" />
        ))}
    </div>
  );
}
