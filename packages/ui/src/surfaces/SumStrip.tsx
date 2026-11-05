import type { ReactNode } from "react";

export interface SumStripItem {
  key: string;
  /** Muted 12px caption above the value. */
  label: ReactNode;
  value: ReactNode;
  /** Value weight: bold (default, old `<b>`) or 550 (the month close facts). */
  weight?: "bold" | "demi";
  /** Tooltip of the value. */
  title?: string;
  /** Right after the value, inline (an edit button, a status tag). */
  after?: ReactNode;
}

/** The summary strip under a budget card's content (old `.bd-sum`: rule above, 12px gaps, items 22px apart, each a
 * muted caption over a bold value). */
export function SumStrip({ items }: { items: readonly SumStripItem[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-5.5 border-t border-border pt-3">
      {items.map((item) => (
        <div key={item.key}>
          <span className="block text-xs text-fg-muted">{item.label}</span>
          <b title={item.title} className={item.weight === "demi" ? "font-demi" : "font-bold"}>
            {item.value}
          </b>
          {item.after}
        </div>
      ))}
    </div>
  );
}
