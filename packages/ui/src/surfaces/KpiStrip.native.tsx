// The KPI strip at the bottom of a phone tile (visual.md "A KPI strip inside a card"): 2-3 equal cells
// split by hairlines, full-bleed to the tile's edges (it undoes the tile's 20 pt padding) under a top hairline.
import type { ReactNode } from "react";
import { Text, View } from "react-native";

export interface KpiStripItem {
  label: string;
  /** Usually a value component (`Money`, `Percent`); a string renders in the value look. */
  value: ReactNode;
}

export interface KpiStripProps {
  items: readonly KpiStripItem[];
}

/** Equal label / value cells; place it last in a `Tile`. */
export function KpiStrip({ items }: KpiStripProps) {
  return (
    <View className="-mx-5 -mb-5 mt-4 flex-row border-t border-border">
      {items.map((item, index) => (
        <View
          key={item.label}
          accessible
          className={`flex-1 gap-0.5 px-3 pb-4.5 pt-4 ${index > 0 ? "border-l border-border" : ""}`}
        >
          <Text numberOfLines={1} className="text-caption text-fg-muted">
            {item.label}
          </Text>
          {typeof item.value === "string" ? (
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              className="text-title font-heavy text-fg tabular-nums"
            >
              {item.value}
            </Text>
          ) : (
            item.value
          )}
        </View>
      ))}
    </View>
  );
}
