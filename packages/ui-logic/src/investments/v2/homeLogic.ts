// Pure helpers that lived inside the old Home.tsx and ReviewDeck.tsx (ab24ab6 frontend/src/modules/investments/v2),
// moved unchanged so the ported screens share them.
import { addDays } from "../../core/time.js";
import type { PerfPoint } from "./types.js";

/** Market change over the last 7 days: money without the flows in between, TWR ratio for the percent. */
export function weekMove(
  points: PerfPoint[],
  asOf: string,
): { money: number; pct: number | null } | null {
  if (points.length < 2) return null;
  const from = addDays(asOf, -7);
  let k = 0;
  for (let i = 0; i < points.length; i++) if ((points[i] as PerfPoint).date <= from) k = i;
  const a = points[k] as PerfPoint,
    b = points[points.length - 1] as PerfPoint;
  if (a.value == null || b.value == null || a === b) return null;
  const flows = points.slice(k + 1).reduce((s, p) => s + (p.flow ?? 0), 0);
  const ratio = a.twr != null && b.twr != null ? (1 + b.twr) / (1 + a.twr) - 1 : null;
  return { money: b.value - a.value - flows, pct: ratio };
}

/** Cut at a word boundary to at most `n` characters plus an ellipsis (the deck's card texts). */
export const clip = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s;
