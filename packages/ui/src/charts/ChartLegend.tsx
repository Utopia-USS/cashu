import { cls } from "./classes.js";
import { BG, BORDER, LOOK } from "./look.js";
import { colorRole } from "./scene.js";
import type { ChartLegendProps, LegendItem, LegendMark } from "./types.js";

/** `.legend i` per mark (old index.css 553-561): a 14 px line (2 px solid / dashed, 1 px dashed or dotted for
 * levels), a 9 px swatch or a 7 px dot, 5 px before the label. */
const MARK: Record<LegendMark, string> = {
  main: "w-3.5 h-0 border-t-2 border-solid",
  bench: "w-3.5 h-0 border-t-2 border-dashed border-bench",
  alert: "w-3.5 h-0 border-t border-dashed border-warning",
  rule: "w-3.5 h-0 border-t border-dashed border-fg-muted",
  agent: "w-3.5 h-0 border-t border-dashed border-info",
  cost: "w-3.5 h-0 border-t border-dotted border-fg-muted",
  swatch: "size-2.25 rounded-4xs",
  buy: "size-1.75 rounded-full bg-positive",
  sell: "size-1.75 rounded-full bg-negative",
};

function markClass(item: LegendItem): string {
  const role = colorRole(item.color ?? "accent");
  return cls(
    "mr-1.25",
    // `stacked`: the old `.split .main {display: grid}` hit (a block above the label), and its
    // `display: contents` at <= 900 px (no mark at all).
    item.stacked ? "block max-split:hidden" : "inline-block align-middle",
    MARK[item.mark],
    item.mark === "main" && BORDER[role],
    item.mark === "swatch" && BG[role],
  );
}

/** The legend row over a chart (old `.legend`): marks in the series colours with their labels, wrapping. */
export function ChartLegend({ items, className }: ChartLegendProps) {
  return (
    <div className={cls(LOOK.legend, className)}>
      {items.map((item) => (
        <span key={item.label}>
          <i className={markClass(item)} aria-hidden />
          {item.label}
        </span>
      ))}
    </div>
  );
}
