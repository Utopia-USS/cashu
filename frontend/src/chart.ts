// Chart geometry of the v2 widgets (design/v2/v2.js is the behaviour contract): scales, paths, right-side
// label stacking with leaders, donut arcs with surface gaps, bars and sparklines. Pure, no DOM: the SVG
// components in charts.tsx draw what these return, and `npm test` checks the numbers.

export type Pt = [x: number, y: number];

/** Padded min/max of the values (6 % of the span each side, like the mock); a flat series gets a
 * band around its value so it draws as a line in the middle. `ymin` / `ymax` pin either end. */
export function extent(values: number[], opts: { pad?: number; ymin?: number; ymax?: number } = {}): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v));
  if (!finite.length) return [0, 1];
  let lo = Math.min(...finite), hi = Math.max(...finite);
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const pad = opts.pad ?? 0.06;
  lo -= span * pad;
  hi += span * pad;
  if (opts.ymin != null) lo = opts.ymin;
  if (opts.ymax != null) hi = opts.ymax;
  if (hi <= lo) hi = lo + 1;
  return [lo, hi];
}

/** Linear map from a domain to a range (pixels). */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v: number) => r0 + (v - d0) * k;
}

/** Evenly spaced tick values from lo to hi (inclusive), `count` intervals. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  const n = Math.max(1, Math.round(count));
  return Array.from({ length: n + 1 }, (_, t) => lo + ((hi - lo) * t) / n);
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** "M0,1L2,3..." of the points; null y values break the line into segments. */
export function linePath(points: (Pt | null)[]): string {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!p || !Number.isFinite(p[1])) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${f1(p[0])},${f1(p[1])}`;
    pen = true;
  }
  return d;
}

/** Closed area under a line down to `baseY` (first and last point of each segment). */
export function areaPath(points: Pt[], baseY: number): string {
  if (points.length < 2) return "";
  const first = points[0], last = points[points.length - 1];
  return `${linePath(points)}L${f1(last[0])},${f1(baseY)}L${f1(first[0])},${f1(baseY)}Z`;
}

export interface StackLabel { y: number; ly: number }

/** Right-side labels (line ends + level labels) nudged apart when closer than `gap` px, top to bottom;
 * the whole stack moves up when it overflows `bottom`. Returns new objects with `ly` (label y) set; a
 * leader is drawn when |ly - y| > 1. Input order is kept in the output. */
export function stackLabels<T extends { y: number }>(items: T[], gap = 13, bottom = Infinity): (T & StackLabel)[] {
  const out = items.map((it) => ({ ...it, ly: it.y }));
  const sorted = [...out].sort((a, b) => a.y - b.y);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].ly - sorted[k - 1].ly < gap) sorted[k].ly = sorted[k - 1].ly + gap;
  }
  const over = sorted.length ? sorted[sorted.length - 1].ly - bottom : 0;
  if (over > 0) for (const it of sorted) it.ly -= over;
  return out;
}

/** Sparkline (72 x 22 like the mock): path, last point, tone from first vs last value. Fewer than two
 * finite values draw nothing; a flat series draws in the middle. */
export function sparkline(values: (number | null | undefined)[], w = 72, h = 22): { d: string; last: Pt | null; tone: "pos" | "neg" | "flat" } {
  const vals = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (vals.length < 2) return { d: "", last: null, tone: "flat" };
  const min = Math.min(...vals), max = Math.max(...vals);
  const x = (i: number) => (i / (vals.length - 1)) * w;
  const y = (v: number) => (max === min ? h / 2 : h - 2 - ((v - min) / (max - min)) * (h - 4));
  const pts: Pt[] = vals.map((v, i) => [x(i), y(v)]);
  const first = vals[0], lastV = vals[vals.length - 1];
  const tone = lastV > first ? "pos" : lastV < first ? "neg" : "flat";
  return { d: linePath(pts), last: pts[pts.length - 1], tone };
}

/** Donut segments: `paths` (SVG d) per value, outer radius size/2 - 2, ring `thickness`, a surface gap of
 * `gapPx` between segments (angle = gap / radius). Zero and negative values get no segment (null). */
export function donutArcs(values: number[], size = 112, thickness = 13, gapPx = 2): (string | null)[] {
  const r = size / 2 - 2, ri = r - thickness, c = size / 2;
  const total = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  if (total <= 0) return values.map(() => null);
  const positive = values.filter((v) => v > 0).length;
  const gap = positive > 1 ? gapPx / r : 0;
  let a0 = -Math.PI / 2;
  return values.map((v) => {
    if (!(v > 0)) return null;
    const a1 = a0 + (v / total) * Math.PI * 2;
    // A single full ring cannot be one arc (start == end): two halves.
    const g0 = a0 + gap / 2, g1 = a1 - gap / 2;
    a0 = a1;
    if (g1 <= g0) return null;
    const p = (rr: number, a: number) => `${f1(c + rr * Math.cos(a))},${f1(c + rr * Math.sin(a))}`;
    if (g1 - g0 >= Math.PI * 2 - 1e-9) {
      const m = g0 + Math.PI;
      return `M${p(r, g0)}A${r},${r},0,0,1,${p(r, m)}A${r},${r},0,0,1,${p(r, g0)}Z`
        + `M${p(ri, g0)}A${ri},${ri},0,0,0,${p(ri, m)}A${ri},${ri},0,0,0,${p(ri, g0)}Z`;
    }
    const large = g1 - g0 > Math.PI ? 1 : 0;
    return `M${p(r, g0)}A${r},${r},0,${large},1,${p(r, g1)}L${p(ri, g1)}A${ri},${ri},0,${large},0,${p(ri, g0)}Z`;
  });
}

export interface BarBox { x: number; y: number; w: number; h: number; cx: number }

/** Bars in slots across `w` (bar width min(22, 60 % of the slot)), heights against max(values, plan) x 1.1;
 * `top` / `bottom` reserve label space. Returns one box per value (h = 0 for zero or negative). */
export function barLayout(values: number[], w: number, h: number, opts: { plan?: number | null; top?: number; bottom?: number; maxBar?: number } = {}): { boxes: BarBox[]; y: (v: number) => number } {
  const top = opts.top ?? 14, bottom = opts.bottom ?? 18;
  const max = Math.max(...values.map((v) => (Number.isFinite(v) ? v : 0)), opts.plan ?? 0, 0) * 1.1 || 1;
  const n = Math.max(1, values.length), slot = w / n, bw = Math.min(opts.maxBar ?? 22, slot * 0.6);
  const y = linear(0, max, h - bottom, top);
  const boxes = values.map((v, i) => {
    const x = i * slot + (slot - bw) / 2;
    const val = Number.isFinite(v) && v > 0 ? v : 0;
    return { x, y: y(val), w: bw, h: y(0) - y(val), cx: x + bw / 2 };
  });
  return { boxes, y };
}

/** Indices of up to `count` x labels spread over the series: first, last and evenly between. */
export function labelIndices(n: number, count = 5): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const k = Math.max(2, Math.min(count, n));
  return [...new Set(Array.from({ length: k }, (_, i) => Math.round((i / (k - 1)) * (n - 1))))];
}

/** Nearest data index to a pointer x inside [x0, x1] for n evenly spaced points. */
export function nearestIndex(px: number, n: number, x0: number, x1: number): number {
  if (n <= 1 || x1 <= x0) return 0;
  const i = Math.round(((px - x0) / (x1 - x0)) * (n - 1));
  return Math.max(0, Math.min(n - 1, i));
}

/** Closed band between an upper and a lower edge (same x positions): stacked areas. */
export function bandPath(upper: Pt[], lower: Pt[]): string {
  if (upper.length < 2 || lower.length !== upper.length) return "";
  const back = [...lower].reverse();
  return `${linePath(upper)}${back.map((p) => `L${f1(p[0])},${f1(p[1])}`).join("")}Z`;
}

/** Stacked layers: assets (>= 0) stacked upward from 0 in `order`, liabilities (< 0) downward; returns
 * per layer the lower and upper value at each point, plus the min / max for the axis. */
export function stackLayers(rows: Record<string, number>[], keys: string[]): { layers: { key: string; lo: number[]; hi: number[] }[]; min: number; max: number } {
  const pos = rows.map(() => 0), neg = rows.map(() => 0);
  let min = 0, max = 0;
  const layers = keys.map((key) => {
    const lo: number[] = [], hi: number[] = [];
    rows.forEach((r, i) => {
      const v = r[key] ?? 0;
      if (v >= 0) { lo.push(pos[i]); pos[i] += v; hi.push(pos[i]); } else { hi.push(neg[i]); neg[i] += v; lo.push(neg[i]); }
      max = Math.max(max, pos[i]);
      min = Math.min(min, neg[i]);
    });
    return { key, lo, hi };
  });
  return { layers, min, max };
}

/** Opacity of the strong end of an area gradient (F7 PX1): the flat fill's opacity x 1.6, capped at 0.35. */
export function fadeOpacity(flat: number): number {
  return Math.min(0.35, Math.round(flat * 1.6 * 1000) / 1000);
}

/** Vertical extent of an area's fade gradient (userSpaceOnUse, F7 PX1): from the plot edge away from the
 * area's baseline (strong) to the baseline (transparent). The usual baseline is the plot bottom, so the
 * gradient runs plot top -> plot bottom (not to the value 0: the y axis does not start at 0); an area hung
 * from a line near the top (drawdown up to 0) fades towards that line instead. */
export function areaFade(baseY: number, top: number, bottom: number): { y1: number; y2: number } {
  return baseY <= (top + bottom) / 2 ? { y1: bottom, y2: baseY } : { y1: top, y2: baseY };
}
