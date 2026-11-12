// The progress of a short flow (setup steps, a triage deck): equal segments, the done ones in ink.
import { View } from "react-native";
import { S } from "./feedback.strings.js";

export interface ProgressDotsProps {
  total: number;
  done: number;
}

/** A row of `total` segments, the first `done` filled. */
export function ProgressDots({ total, done }: ProgressDotsProps) {
  const count = Math.max(0, Math.floor(total));
  const filled = Math.min(Math.max(0, Math.floor(done)), count);
  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: count, now: filled, text: S.stepOf(filled, count) }}
      className="flex-row gap-1"
    >
      {Array.from({ length: count }, (_, index) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions, they have no identity.
          key={index}
          className={`h-1 flex-1 rounded-full ${index < filled ? "bg-fg" : "bg-subtle"}`}
        />
      ))}
    </View>
  );
}
