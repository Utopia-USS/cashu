// The spending donut of the budget screen (design/desktop/budget/one-screen.html `.donut`, the look the owner
// iterated): a solid ring (stroke 24 on r 86 in a 216 box), flat ends with 2.5px gaps, no track, no glow; the
// centre holds the total only. Hovering a segment or its row scales that segment out from the centre, fades the
// others and shows a tip at the segment's outer edge that glides to the next one; the drilled category stays
// out while nothing is hovered. Segments sweep in once. Pure: slices come formatted from the screen hook.
import type { SliceState } from "./budgetHomeState.js";
import { useEntrance } from "./motion.js";

const BOX = 216;
const R = 86;
const STROKE = 24;
const GAP = 2.5;
const C = 2 * Math.PI * R;
const MID = BOX / 2;
/** Where the tip sits: just outside the scaled ring. */
const TIP_R = 118;
const OUT = 1.07;
/** How far the tip may reach past the ring's box: the tile's side padding, less a little air. */
const TILE_PAD = 14;
const FADED = 0.5;

/** The ring's arcs: dash length, offset and the angle of each segment's middle (0 = top, clockwise). */
function ringArcs(values: readonly number[]): { dash: number; offset: number; mid: number }[] {
  const total = values.reduce((a, v) => (v > 0 ? a + v : a), 0);
  let at = 0;
  return values.map((v) => {
    const len = total > 0 && v > 0 ? (v / total) * C : 0;
    const arc = {
      dash: len > 0 ? Math.max(0.6, len - GAP) : 0,
      offset: -at,
      mid: ((at + len / 2) / C) * 2 * Math.PI,
    };
    at += len;
    return arc;
  });
}

export interface SpendingRingProps {
  slices: readonly SliceState[];
  total: string;
  /** Accessible name (the ring itself is a picture; the rows next to it are the controls). */
  label: string;
  /** The hovered slice key (from the ring or a row). */
  hover: string | null;
  onHover(key: string | null): void;
  /** The drilled category: out while nothing is hovered. */
  selected: string | null;
  onPick(slice: SliceState): void;
}

export function SpendingRing({
  slices,
  total,
  label,
  hover,
  onHover,
  selected,
  onPick,
}: SpendingRingProps) {
  const arcs = ringArcs(slices.map((s) => s.value));
  const svg = useEntrance<SVGSVGElement>(
    "circle[data-arc]",
    (el) => {
      const final = el.getAttribute("stroke-dasharray");
      return final ? [{ strokeDasharray: `0 ${C}` }, { strokeDasharray: final }] : null;
    },
    (i) => ({ duration: 760, delay: 220 + i * 55 }),
  );
  const focus = hover ?? selected;
  const at = slices.findIndex((s) => s.key === hover);
  const tipSlice = at >= 0 ? slices[at] : undefined;
  const mid = at >= 0 ? (arcs[at]?.mid ?? 0) : 0;
  const sin = Math.sin(mid);
  const cos = Math.cos(mid);
  return (
    <div className="relative size-54">
      <svg
        ref={svg}
        viewBox={`0 0 ${BOX} ${BOX}`}
        role="img"
        aria-label={`${label}: ${slices.map((s) => `${s.label} ${s.share}`).join(", ")}`}
        className="size-full -rotate-90 overflow-visible"
      >
        {slices.map((s, i) => {
          const arc = arcs[i];
          if (!arc || arc.dash <= 0) return null;
          const on = focus === s.key;
          return (
            <circle
              key={s.key}
              data-arc
              r={R}
              cx={MID}
              cy={MID}
              fill="none"
              stroke={s.color}
              strokeWidth={STROKE}
              strokeDasharray={`${arc.dash} ${C}`}
              strokeDashoffset={arc.offset}
              opacity={focus !== null && !on ? FADED : 1}
              className="cursor-pointer transition-[transform,opacity] duration-280 ease-tile"
              style={{
                transformBox: "view-box",
                transformOrigin: "50% 50%",
                transform: on ? `scale(${OUT})` : "none",
              }}
              onPointerEnter={() => onHover(s.key)}
              onPointerLeave={() => onHover(null)}
              // A pointer pick only: the category rows beside the ring are its keyboard and screen reader path.
              onPointerUp={(e) => {
                if (e.button === 0) onPick(s);
              }}
            />
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
        <span className="whitespace-nowrap text-4xl-minus font-bold leading-dense tracking-dense tabular-nums">
          {total}
        </span>
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute z-10 grid gap-0.5 whitespace-nowrap rounded-button-lg border border-border bg-surface-raised px-3 py-2.25 shadow-tip transition-[opacity,left,top] duration-200 ease-tile ${tipSlice ? "opacity-100" : "opacity-0"}`}
        style={{
          left: MID + TIP_R * sin,
          top: MID - TIP_R * cos,
          // Left of the ring the tip hangs left of its point, but never further than the tile's padding.
          transform: `translate(${sin >= 0 ? "0%" : `max(-100%, ${-(MID + TIP_R * sin + TILE_PAD)}px)`}, ${cos >= 0 ? "-100%" : "0%"})`,
        }}
      >
        {tipSlice && (
          <>
            <span className="flex items-center gap-1.75 text-xs font-demi text-fg-secondary">
              <i className="size-1.75 rounded-full" style={{ background: tipSlice.color }} />
              {tipSlice.label}
            </span>
            <b className="text-base font-bold tracking-heading tabular-nums">{tipSlice.amount}</b>
            <span className="text-2xs-plus text-fg-muted">{tipSlice.shareText}</span>
          </>
        )}
      </div>
    </div>
  );
}
