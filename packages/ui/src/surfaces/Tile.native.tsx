// The phone card (design/mobile/companion prototype `.tile`, visual.md "Surfaces"): a raised surface with a
// hairline, 28 pt corners and 20 pt padding; a quiet header row (title left, meta right) above the rows.
// Not built on Card.native.tsx: Card has only the md / lg paddings (16 / 24 pt), no tone and no press, and
// its className is layout only.
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

export interface TileProps {
  /** Header title (quieter than the data under it). */
  title?: string;
  /** Header meta on the right: a count, a date, a link label. */
  meta?: ReactNode;
  /** `warning` fills the tile with the warning tint and drops the hairline. */
  tone?: "default" | "warning";
  /** Makes the whole tile a button; pressed, it takes the subtle fill. */
  onPress?(): void;
  /** Accessible name of a pressable tile when its title does not say where it leads (pressable only). */
  accessibilityLabel?: string;
  children?: ReactNode;
}

const tones = {
  default: "border border-border bg-surface-raised",
  warning: "bg-warning-bg",
} as const;

/** One phone card: optional header row, then its rows or figure as children. */
export function Tile({
  title,
  meta,
  tone = "default",
  onPress,
  accessibilityLabel,
  children,
}: TileProps) {
  const header =
    title !== undefined || meta !== undefined ? (
      <View className="mb-3 flex-row items-center justify-between gap-2">
        {title !== undefined && (
          <Text className="shrink text-caption font-medium text-fg-secondary">{title}</Text>
        )}
        {typeof meta === "string" ? (
          <Text className="text-caption text-fg-muted">{meta}</Text>
        ) : (
          meta
        )}
      </View>
    ) : null;
  const look = `rounded-widget p-5 ${tones[tone]}`;
  if (onPress)
    return (
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        className={`${look} active:bg-subtle`}
      >
        {header}
        {children}
      </Pressable>
    );
  return (
    <View className={look}>
      {header}
      {children}
    </View>
  );
}
