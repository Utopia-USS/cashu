import { Pressable, Text, View } from "react-native";
import { Swatch, type SwatchColor } from "../lists/Swatch.js";

export interface CategoryOption {
  key: string;
  /** Visible, translated name of the category. */
  label: string;
  swatch: SwatchColor;
}

export interface CategoryGridProps {
  options: readonly CategoryOption[];
  /** Key of the chosen category (shown inverted). */
  selected: string | null;
  /** Key of the suggested category (accent ring). */
  suggested?: string | null;
  /** Translated hint read with the suggested cell ("Suggested"), so the ring is not colour-only. */
  suggestedHint?: string;
  /** Every option shown; while false only the first `collapsedCount` plus the expand cell. */
  expanded: boolean;
  /** Options shown while collapsed (default 5). */
  collapsedCount?: number;
  onPick(key: string): void;
  onExpand(): void;
  /** Translated text of the expand cell, shown as given (callers pass "More"). */
  expandLabel: string;
  /** Cells per row (default 3); 2 gives long category names room in a sheet. */
  columns?: 2 | 3;
}

// Each cell is a half or a third of the row; the padding of the cell wrapper is the gutter (gap-2 between
// cells).
const CELL = { 2: "w-1/2 p-1", 3: "w-1/3 p-1" } as const;
const FACE = "min-h-11 flex-row items-center gap-2 rounded-lg border p-3";

/**
 * Category picker of the phone (prototype `catGrid`): three (or two) columns of cells with the category swatch,
 * the chosen one inverted, the suggestion ringed in the accent; collapsed to the first few plus an
 * expand cell until the owner asks for all.
 */
export function CategoryGrid({
  options,
  selected,
  suggested = null,
  suggestedHint,
  expanded,
  collapsedCount = 5,
  onPick,
  onExpand,
  expandLabel,
  columns = 3,
}: CategoryGridProps) {
  const collapsed = !expanded && options.length > collapsedCount;
  const shown = collapsed ? options.slice(0, collapsedCount) : options;
  return (
    <View className="-m-1 flex-row flex-wrap">
      {shown.map((option) => {
        const on = option.key === selected;
        const hinted = option.key === suggested;
        return (
          <View key={option.key} className={CELL[columns]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={option.label}
              accessibilityHint={hinted ? suggestedHint : undefined}
              accessibilityState={{ selected: on }}
              onPress={() => onPick(option.key)}
              className={`${FACE} ${on ? "bg-fg" : "bg-subtle active:bg-chip"} ${hinted ? "border-accent" : "border-transparent"}`}
            >
              <Swatch color={option.swatch} />
              <Text
                numberOfLines={2}
                className={`shrink text-body ${on ? "text-surface" : "text-fg"}`}
              >
                {option.label}
              </Text>
            </Pressable>
          </View>
        );
      })}
      {collapsed && (
        <View className={CELL[columns]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expandLabel}
            accessibilityState={{ expanded: false }}
            onPress={onExpand}
            className={`${FACE} border-transparent bg-subtle active:bg-chip`}
          >
            <Text numberOfLines={1} className="shrink text-body text-fg-secondary">
              {expandLabel}
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}
