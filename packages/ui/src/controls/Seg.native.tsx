import { Pressable, Text, View } from "react-native";
import type { SegProps } from "./Seg.types.js";

export type { SegProps } from "./Seg.types.js";

// A 32 pt segment grows to the 44 pt minimum touch target without changing its look (it grows with
// Dynamic Type through `min-h`).
const HIT_SLOP = { top: 6, bottom: 6 } as const;

/**
 * Segmented single choice on the phone (prototype `.seg`, `.seg.full`): a sunken track with the selected
 * segment raised. `quiet` is the desktop's variant and the phone track is always quiet.
 *
 * Why Pressables and not a native segmented control: the universal @expo/ui Picker has no segmented
 * appearance, and the platform layer's SwiftUI `Picker` + `pickerStyle("segmented")` draws the system
 * UISegmentedControl, whose look (height, track, selected chip, type) is not the visual spec's `.seg`
 * and cannot be styled to it. So the track is a `tablist` and every segment a `tab` with its `selected`
 * state, which VoiceOver announces as "tab, 1 of 3" like the native control.
 */
export function Seg<T extends string | number | null>({
  items,
  value,
  onChange,
  full,
  label,
  disabled,
  title,
  className = "",
}: SegProps<T>) {
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      accessibilityHint={title}
      className={`flex-row rounded-md bg-subtle p-0.5 ${full ? "w-full" : "self-start"} ${className}`}
    >
      {items.map(([text, item]) => {
        const on = item === value;
        return (
          <Pressable
            key={String(item)}
            accessibilityRole="tab"
            accessibilityLabel={text}
            accessibilityState={{ selected: on, disabled: disabled === true }}
            disabled={disabled}
            hitSlop={HIT_SLOP}
            onPress={() => onChange(item)}
            className={`min-h-8 py-1 items-center justify-center rounded-sm-plus px-2.5 ${full ? "flex-1" : ""} ${on ? "bg-surface-raised" : ""} ${disabled ? "opacity-50" : ""}`}
          >
            <Text
              numberOfLines={1}
              className={`text-sm font-medium ${on ? "text-fg" : "text-fg-muted"}`}
            >
              {text}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
