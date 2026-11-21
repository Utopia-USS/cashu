// A freshness line (visual.md "status = dot + text"): a 6 pt dot in the status colour and a caption, read
// as one text ("synced 2 h ago").
import type { ReactNode } from "react";
import { Text, View } from "react-native";

export interface FreshLineProps {
  /** `ok` fresh, `warn` stale or needs attention, `muted` not connected / no data. */
  tone: "ok" | "warn" | "muted";
  children: ReactNode;
}

const dots = { ok: "bg-positive", warn: "bg-warning", muted: "bg-fg-muted" } as const;

/** Status dot + caption. */
export function FreshLine({ tone, children }: FreshLineProps) {
  return (
    <View accessible accessibilityRole="text" className="flex-row items-center gap-1.5">
      <View className={`size-1.5 rounded-full ${dots[tone]}`} />
      <Text className="shrink text-caption text-fg-muted">{children}</Text>
    </View>
  );
}
