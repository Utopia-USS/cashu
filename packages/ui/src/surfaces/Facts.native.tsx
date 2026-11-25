// The facts of a phone tile (visual.md `.fact`, the hero facts in a 2x2 grid): sub-tiles two (or three) to a row, each a
// muted label, a heavy value and an optional muted detail. The one sub-box a tile may hold.
import type { ReactNode } from "react";
import { Text, View } from "react-native";

export interface FactsItem {
  label: string;
  /** Usually a value component (`Money`, `Percent`); a string renders in the value look. */
  value: ReactNode;
  detail?: ReactNode;
}

export interface FactsProps {
  items: readonly FactsItem[];
  /** Facts per row (default 2, the 2x2 grid); 3 sets three facts in one row. */
  columns?: 2 | 3;
}

function Fact({ label, value, detail }: FactsItem) {
  return (
    <View accessible className="flex-1 gap-0.5 rounded-tile bg-subtle p-3">
      <Text numberOfLines={1} className="text-caption text-fg-muted">
        {label}
      </Text>
      {typeof value === "string" ? (
        <Text numberOfLines={1} className="text-title font-heavy text-fg tabular-nums">
          {value}
        </Text>
      ) : (
        value
      )}
      {typeof detail === "string" ? (
        <Text numberOfLines={2} className="text-caption text-fg-muted">
          {detail}
        </Text>
      ) : (
        detail
      )}
    </View>
  );
}

// Fillers of a short last row, so its facts keep the cell width (at most columns - 1 of them).
const SPACERS = ["spacer-1", "spacer-2"] as const;

/** Facts `columns` to a row; a short last row keeps the cell width (spacers fill the rest). */
export function Facts({ items, columns = 2 }: FactsProps) {
  const rows: FactsItem[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View className="gap-2">
      {rows.map((row) => (
        <View key={row.map((item) => item.label).join("|")} className="flex-row gap-2">
          {row.map((item) => (
            <Fact key={item.label} {...item} />
          ))}
          {SPACERS.slice(0, columns - row.length).map((key) => (
            <View key={key} className="flex-1" />
          ))}
        </View>
      ))}
    </View>
  );
}
