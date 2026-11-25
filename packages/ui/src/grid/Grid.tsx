import type { CSSProperties, ReactNode } from "react";
import { type Span, splitNarrowOrder, twoColumnOrder } from "./gridOrder.js";

export interface GridItem {
  id: string;
  /** Columns of the three-column grid the item spans. */
  span: Span;
  node: ReactNode;
  /** Consecutive span-1 items with the same key share one column at three columns. */
  stack?: string;
  /** Two columns: a wide item placed after the pending pair of single widgets. */
  defer?: boolean;
}

export interface GridProps {
  items: readonly GridItem[];
  /** Item id to ring once (a redirect focused it); every cell carries `data-slot` = its id. */
  flash?: string | null;
  /** Layout only (margin). */
  className?: string;
}

// Cell spans per breakpoint (old `.g3 .s2 / .s3 / .s1-full` with the 1180 / 760 rules) and the `--o` order
// that applies from two columns down.
const spans = {
  1: "",
  2: "col-span-2 max-narrow:col-auto",
  3: "col-span-3 max-wide:col-span-2 max-narrow:col-auto",
} as const;
const alonePair = "max-wide:col-span-2 max-narrow:col-auto";
const ordered = "min-w-0 max-wide:order-(--o)";
const ringOnce = "[&>*]:transition-[box-shadow,border-color] [&>*]:duration-400";
const flashed = "[&>*]:border-accent [&>*]:shadow-none [&>*]:ring-1 [&>*]:ring-accent";

/** Dashboard grid on thirds (old `.g3`): 3 columns, 2 at <= 1180 px (single widgets pair up), 1 at <= 760 px;
 * body text 14px / 1.45. */
export function Grid({ items, flash, className = "" }: GridProps) {
  const present = items.filter((item) => item.node != null && item.node !== false);
  const { order, alone } = twoColumnOrder(present);
  const cell = (item: GridItem) => (
    <div
      key={item.id}
      data-slot={item.id}
      className={`${ordered} ${spans[item.span]} ${alone.has(item.id) ? alonePair : ""} ${ringOnce} ${flash === item.id ? flashed : ""}`}
      style={{ "--o": order.get(item.id) ?? 0 } as CSSProperties}
    >
      {item.node}
    </div>
  );
  const out: ReactNode[] = [];
  for (let k = 0; k < present.length; k++) {
    const item = present[k] as GridItem;
    if (item.stack && item.span === 1) {
      const group = [item];
      while (k + 1 < present.length) {
        const next = present[k + 1] as GridItem;
        if (next.stack !== item.stack || next.span !== 1) break;
        group.push(next);
        k++;
      }
      out.push(
        group.length > 1 ? (
          <div
            key={`stack:${item.id}`}
            className="grid min-w-0 content-start gap-4 max-wide:contents"
          >
            {group.map(cell)}
          </div>
        ) : (
          cell(item)
        ),
      );
    } else out.push(cell(item));
  }
  return (
    <div
      className={`grid grid-cols-3 items-start gap-4 text-md leading-widget max-wide:grid-cols-2 max-narrow:grid-cols-1 ${className}`}
    >
      {out}
    </div>
  );
}

export interface SplitItem {
  id: string;
  node: ReactNode;
}

export interface SplitProps {
  /** The main column (2/3), top to bottom. */
  main: readonly SplitItem[];
  /** The rail (1/3), top to bottom; its first two items lead the single column below 900 px. */
  rail: readonly SplitItem[];
  /** Layout only. */
  className?: string;
}

/** Grid cell with a main column (2/3) and a rail (1/3) aligned to the thirds of `Grid` (old `.split`):
 * a 320 px rail at <= 1180 px, the rail under the main column (two-up) on a portrait screen wider than
 * 900 px, one column below 900 px with the rail's first two widgets on top. */
export function Split({ main, rail, className = "" }: SplitProps) {
  const order = splitNarrowOrder(
    main.map((item) => item.id),
    rail.map((item) => item.id),
  );
  const cell = (item: SplitItem) => (
    <div
      key={item.id}
      className="min-w-0 max-split:order-(--o)"
      style={{ "--o": order.get(item.id) ?? 0 } as CSSProperties}
    >
      {item.node}
    </div>
  );
  return (
    <div
      className={`grid grid-cols-[minmax(0,calc((100%_-_32px)_*_2_/_3_+_16px))_minmax(0,1fr)] items-start gap-4 max-wide:grid-cols-[minmax(0,1fr)_320px] min-split:portrait:grid-cols-[minmax(0,1fr)] max-split:grid-cols-[minmax(0,1fr)] ${className}`}
    >
      <div className="grid min-w-0 content-start gap-4 max-split:contents">{main.map(cell)}</div>
      <div className="grid min-w-0 content-start gap-4 min-split:portrait:grid-cols-2 max-split:contents">
        {rail.map(cell)}
      </div>
    </div>
  );
}
