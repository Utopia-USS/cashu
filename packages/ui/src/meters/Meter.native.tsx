// The phone's meters (visual.md `.track`, prototype `.pace`): a share bar on a subtle track, and the month
// pace bar with a marker at the usual share. The fill width is data geometry (a percentage of the track).
import { Text, View } from "react-native";

export interface MeterProps {
  /** Filled part of the track, clamped to [0, 1]. */
  share: number;
  tone?: "default" | "accent" | "warning";
  /** `thin` (5 pt, inside a list row) or `regular` (8 pt). */
  height?: "thin" | "regular";
}

const fills = { default: "bg-fg-secondary", accent: "bg-accent", warning: "bg-warning" } as const;
const heights = { thin: "h-1.25", regular: "h-2" } as const;

const percent = (share: number) => `${share * 100}%` as const;

/** A decorative share bar: the row or the caption beside it states the value. */
export function Meter({ share, tone = "default", height = "regular" }: MeterProps) {
  const clamped = Math.min(Math.max(share, 0), 1);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className={`overflow-hidden rounded-full bg-subtle ${heights[height]}`}
    >
      <View className={`h-full rounded-full ${fills[tone]}`} style={{ width: percent(clamped) }} />
    </View>
  );
}

export interface PaceMeterProps {
  /** Spent so far as a share of the usual month; the fill stops at 1.2 (past the end of the track). */
  spentShare: number;
  /** Where the usual spending stands today, as a share of the usual month: the marker. */
  usualShare: number;
  labelLeft: string;
  /** Also the accessible value of the meter. */
  labelRight: string;
  rightTone?: "default" | "positive";
}

/** The month pace: spent so far against the usual pace marker, with a caption under each end. */
export function PaceMeter({
  spentShare,
  usualShare,
  labelLeft,
  labelRight,
  rightTone = "default",
}: PaceMeterProps) {
  const spent = Math.min(Math.max(spentShare, 0), 1.2);
  const usual = Math.min(Math.max(usualShare, 0), 1);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={labelLeft}
      accessibilityValue={{ text: labelRight }}
      className="gap-2"
    >
      <View className="h-2 rounded-full bg-subtle">
        <View
          className="absolute inset-y-0 left-0 rounded-full bg-fg-secondary"
          style={{ width: percent(spent) }}
        />
        <View
          className="absolute -top-1 h-4 w-0.5 rounded-5xs bg-fg"
          style={{ left: percent(usual) }}
        />
      </View>
      <View className="flex-row justify-between gap-3">
        <Text className="shrink text-caption text-fg-muted">{labelLeft}</Text>
        <Text
          className={`text-caption ${rightTone === "positive" ? "text-positive" : "text-fg-muted"}`}
        >
          {labelRight}
        </Text>
      </View>
    </View>
  );
}
