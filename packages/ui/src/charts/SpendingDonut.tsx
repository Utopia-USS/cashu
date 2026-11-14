import { type PointerEvent, useState } from "react";
import { LegendRow } from "../lists/LegendRow.js";
import { SumStrip } from "../surfaces/SumStrip.js";
import { Donut } from "./Donut.js";
import { type ChartColor, colorRole, ROLE_VAR } from "./scene.js";

export interface SpendingSlice {
  key: string;
  label: string;
  /** Size of the arc (any unit, positive). */
  value: number;
  /** Formatted amount and share of the legend row and the tooltip. */
  amount: string;
  share: string;
  color: ChartColor;
  /** A collapsed "Reszta" slice: its row toggles these member rows (muted swatches) and its arc opens nothing. */
  members?: readonly SpendingSlice[];
}

export interface SpendingDonutProps {
  /** Accessible name of the ring. */
  label: string;
  slices: readonly SpendingSlice[];
  /** A category was picked (its arc or legend row). */
  onSelect(key: string, label: string): void;
  /** The sum strip under the legend ("Suma wydatków"). */
  total: { label: string; value: string };
}

// Old recharts pie in a 300px box with the default 5px margin: outer radius .9 x 145, inner .58 x 145, no gaps.
const BOX = 265;
const THICK = 46;
const OUTER = BOX / 2 - 2;
const SEP = " : ";

function sliceAt(slices: readonly SpendingSlice[], x: number, y: number): number | null {
  const dx = x - BOX / 2;
  const dy = y - BOX / 2;
  const r = Math.hypot(dx, dy);
  if (r > OUTER || r < OUTER - THICK) return null;
  const total = slices.reduce((a, s) => (s.value > 0 ? a + s.value : a), 0);
  if (total <= 0) return null;
  const turn = (Math.atan2(dy, dx) + Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  let at = 0;
  for (const [i, s] of slices.entries()) {
    if (!(s.value > 0)) continue;
    at += (s.value / total) * Math.PI * 2;
    if (turn <= at) return i;
  }
  return null;
}

/** The spending donut of the budget (old SpendingDonut.tsx): the ring with its hover tooltip, the legend rows
 * (a collapsed "Reszta" row opens its members), the total. */
export function SpendingDonut({ label, slices, onSelect, total }: SpendingDonutProps) {
  const [restOpen, setRestOpen] = useState(false);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const pick = (s: SpendingSlice) => {
    if (s.members) setRestOpen((open) => !open);
    else onSelect(s.key, s.label);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - box.left;
    const y = event.clientY - box.top;
    const i = sliceAt(slices, x, y);
    setHover(i === null ? null : { i, x, y });
  };
  const tip = hover ? slices[hover.i] : undefined;
  const tipText = tip ? `${tip.label}${SEP}${tip.amount} (${tip.share})` : "";
  return (
    <div className="grid grid-cols-1 gap-4">
      <div className="flex h-75 items-center justify-center">
        <div className="relative" onPointerMove={move} onPointerLeave={() => setHover(null)}>
          <Donut
            label={label}
            size={BOX}
            thickness={THICK}
            gap={0}
            segments={slices.map((s) => ({ value: s.value, color: s.color, name: s.label }))}
            onSegmentSelected={(i) => {
              const s = slices[i];
              if (s && !s.members) onSelect(s.key, s.label);
            }}
          />
          {hover && tip && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-10 whitespace-nowrap rounded-control border border-border bg-surface-raised p-2.5 text-sm"
              style={{ left: hover.x + 10, top: hover.y + 10 }}
            >
              <div className="py-1" style={{ color: `var(${ROLE_VAR[colorRole(tip.color)]})` }}>
                {tipText}
              </div>
            </div>
          )}
        </div>
      </div>
      <div>
        {slices.map((s) =>
          s.members ? (
            <div key={s.key}>
              <LegendRow
                swatch={s.color}
                label={s.label}
                amount={s.amount}
                share={s.share}
                expanded={restOpen}
                onPress={() => pick(s)}
              />
              {restOpen &&
                s.members.map((m) => (
                  <LegendRow
                    key={m.key}
                    swatch={m.color}
                    label={m.label}
                    amount={m.amount}
                    share={m.share}
                    onPress={() => onSelect(m.key, m.label)}
                  />
                ))}
            </div>
          ) : (
            <LegendRow
              key={s.key}
              swatch={s.color}
              label={s.label}
              amount={s.amount}
              share={s.share}
              onPress={() => pick(s)}
            />
          ),
        )}
        <SumStrip items={[{ key: "total", label: total.label, value: total.value }]} />
      </div>
    </div>
  );
}
