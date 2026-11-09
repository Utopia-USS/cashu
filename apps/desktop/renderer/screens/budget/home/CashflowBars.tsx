// The hero's income / spending chart (design/desktop/budget/one-screen.html `.chart`): grouped bars per period
// at the period mode's granularity, the selected group at full strength, the others faded, a period in progress
// lighter; hovering a group shows its income, spending and surplus; pressing it selects that period. Round y
// ticks, no net line, no range buttons. Pure: the screen hook hands the groups in, formatted.
import { useState } from "react";
import type { ChartState } from "./budgetHomeState.js";
import { useEntrance, useWidth } from "./motion.js";

const HEIGHT = 196;
const PAD_L = 34;
const PAD_B = 22;
const PAD_T = 6;
const TIP_W = 170;
/** A group that is not the selection (mockup `.grp:not(.sel) .b`). */
const FADED = 0.38;
const FADED_HOVER = 0.7;
/** The bars of a period in progress. */
const PARTIAL = 0.45;

/** A bar with a rounded top, from the baseline up to `h`. */
function barPath(x: number, base: number, w: number, h: number): string {
  if (h <= 0) return "";
  const r = Math.min(3, w / 2, h);
  return `M${x},${base} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`;
}

export function CashflowBars({ chart }: { chart: ChartState }) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const svg = useEntrance<SVGSVGElement>(
    "path[data-bar]",
    () => [{ transform: "scaleY(0)" }, { transform: "scaleY(1)" }],
    (i) => ({ duration: 620, delay: 180 + Math.floor(i / 2) * 28 }),
  );
  const groups = chart.groups;
  const any = groups.some((g) => g.selected);
  const plotW = Math.max(0, width - PAD_L);
  const step = groups.length ? plotW / groups.length : 0;
  const bw = Math.min(16, step * 0.26);
  const y = (v: number) => PAD_T + (HEIGHT - PAD_T - PAD_B) * (1 - v / (chart.top || 1));
  const base = HEIGHT - PAD_B;
  const hovered = hover === null ? null : groups.findIndex((g) => g.key === hover);
  const tip = hovered !== null && hovered >= 0 ? groups[hovered] : undefined;
  const tipX =
    hovered !== null && hovered >= 0
      ? Math.min(width - TIP_W, Math.max(0, PAD_L + step * hovered + step / 2 - TIP_W / 2))
      : 0;
  return (
    <figure ref={box} aria-label={chart.label} className="relative m-0 mt-4.5 h-49 select-none">
      {width > 0 && (
        <svg
          ref={svg}
          width={width}
          height={HEIGHT}
          aria-hidden
          className="pointer-events-none absolute inset-0 overflow-visible"
        >
          {chart.ticks.map((t) => (
            <g key={t.value}>
              <line
                x1={PAD_L}
                x2={width}
                y1={y(t.value)}
                y2={y(t.value)}
                stroke="var(--color-chart-grid)"
              />
              <text
                x={PAD_L - 8}
                y={y(t.value) + 3.5}
                textAnchor="end"
                className="fill-fg-muted text-3xs-plus"
              >
                {t.label}
              </text>
            </g>
          ))}
          {groups.map((g, k) => {
            const cx = PAD_L + step * k + step / 2;
            const strong = !any || g.selected;
            const opacity = strong ? 1 : hover === g.key ? FADED_HOVER : FADED;
            const fillOpacity = g.partial ? PARTIAL : 1;
            return (
              <g key={g.key}>
                <rect
                  x={cx - step / 2 + 2}
                  y={0}
                  width={Math.max(0, step - 4)}
                  height={base + 18}
                  rx={10}
                  className={`transition-colors ${g.selected ? "fill-fg/4" : hover === g.key ? "fill-fg/2" : "fill-transparent"}`}
                />
                <path
                  data-bar
                  d={barPath(cx - bw - 1.5, base, bw, base - y(g.income))}
                  fill="var(--color-positive)"
                  fillOpacity={fillOpacity}
                  opacity={opacity}
                  className="transition-opacity duration-200"
                  style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                />
                <path
                  data-bar
                  d={barPath(cx + 1.5, base, bw, base - y(g.expense))}
                  fill="var(--color-negative)"
                  fillOpacity={fillOpacity}
                  opacity={opacity}
                  className="transition-opacity duration-200"
                  style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                />
                <text
                  x={cx}
                  y={HEIGHT - 5}
                  textAnchor="middle"
                  className={`text-2xs ${g.selected ? "fill-fg font-strong" : "fill-fg-muted"}`}
                >
                  {g.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {/* One button per group over its column: the period it stands for, its figures as the name. */}
      {width > 0 &&
        groups.map((g, k) => (
          <button
            key={g.key}
            type="button"
            aria-label={`${g.tip.title}: ${g.tip.rows.map((r) => `${r.name} ${r.value}`).join(", ")}`}
            aria-pressed={g.selected}
            className="absolute top-0 cursor-pointer rounded-md border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-focus"
            style={{ left: PAD_L + step * k + 2, width: Math.max(0, step - 4), height: base + 18 }}
            onPointerEnter={() => setHover(g.key)}
            onPointerLeave={() => setHover((h) => (h === g.key ? null : h))}
            onFocus={() => setHover(g.key)}
            onBlur={() => setHover(null)}
            onClick={() => chart.select(g.key)}
          />
        ))}
      <div
        aria-hidden
        className={`pointer-events-none absolute -top-2 z-10 grid min-w-37.5 gap-0.75 rounded-button-lg border border-border bg-surface-raised px-2.75 py-2.25 text-xs shadow-tip transition-[opacity,transform] duration-120 ease-tile ${tip ? "opacity-100" : "translate-y-1 scale-97 opacity-0"}`}
        style={{ left: tipX, width: TIP_W }}
      >
        {tip && (
          <>
            <b className="font-strong text-fg">{tip.tip.title}</b>
            {tip.tip.rows.map((r) => (
              <span key={r.name} className="flex gap-3.5 text-fg-muted">
                {r.name}
                <b
                  className={`ml-auto font-strong tabular-nums ${r.negative ? "text-negative" : "text-fg"}`}
                >
                  {r.value}
                </b>
              </span>
            ))}
          </>
        )}
      </div>
    </figure>
  );
}
