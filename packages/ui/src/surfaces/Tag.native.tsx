// The phone twin of the desktop `Tag` (Tag.tsx, the same TagProps): a filled pill at least 22 pt high that
// grows with Dynamic Type (prototype `.tag`, visual.md "Tags"). Native tags are always filled (`solid`
// changes nothing); `title` is desktop only. A pressable tag reaches 44 pt through `hitSlop`.
import { Pressable, Text, View } from "react-native";
import type { TagProps } from "./Tag.types.js";

export type { TagProps, TagTone } from "./Tag.types.js";

const tones = {
  neutral: { box: "bg-chip", text: "text-fg-secondary" },
  positive: { box: "bg-positive-bg", text: "text-positive" },
  negative: { box: "bg-negative-bg", text: "text-negative" },
  warning: { box: "bg-warning-bg", text: "text-warning" },
  info: { box: "bg-info-bg", text: "text-info" },
} as const;

/** 22 pt pill + 2 x 11 pt = the 44 pt hit target. */
const HIT_SLOP = { top: 11, bottom: 11, left: 4, right: 4 } as const;

/** A small status pill; with `onPress` a button that leads to its cause. */
export function Tag({ children, tone = "neutral", onPress, className = "" }: TagProps) {
  const look = tones[tone];
  const label = (
    <Text numberOfLines={1} className={`text-caption font-medium ${look.text}`}>
      {children}
    </Text>
  );
  const box = `min-h-5.5 py-0.5 flex-row items-center self-start rounded-full px-2.25 ${look.box} ${className}`;
  if (onPress)
    return (
      <Pressable
        onPress={onPress}
        hitSlop={HIT_SLOP}
        accessibilityRole="button"
        className={`${box} active:bg-subtle`}
      >
        {label}
      </Pressable>
    );
  return <View className={box}>{label}</View>;
}
