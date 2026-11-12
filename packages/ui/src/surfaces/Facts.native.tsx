// The facts of a phone tile (visual.md `.fact`, the hero facts in a 2x2 grid): sub-tiles two to a row, each a
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
        <Text numberOfLines={1} className="text-caption text-fg-muted">
          {detail}
        </Text>
      ) : (
        detail
      )}
    </View>
  );
}

/** Facts two to a row; an odd last fact keeps half the width. */
export function Facts({ items }: FactsProps) {
  const rows: FactsItem[][] = [];
  for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2));
  return (
    <View className="gap-2">
      {rows.map((row) => (
        <View key={row.map((item) => item.label).join("|")} className="flex-row gap-2">
          {row.map((item) => (
            <Fact key={item.label} {...item} />
          ))}
          {row.length === 1 && <View className="flex-1" />}
        </View>
      ))}
    </View>
  );
}
