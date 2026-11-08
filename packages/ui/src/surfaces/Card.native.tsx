import { View } from "react-native";
import type { CardProps } from "./Card.types.js";

const paddings = { md: "p-4", lg: "p-6" } as const;

/** Native raised surface with the same roles as the desktop card. */
export function Card({ children, padding = "md", label, role, testID, className = "" }: CardProps) {
  return (
    <View
      accessibilityLabel={label}
      accessibilityRole={role === "alert" ? "alert" : undefined}
      accessibilityLiveRegion={role === "status" ? "polite" : undefined}
      testID={testID}
      className={`rounded-widget border border-border bg-surface-raised ${paddings[padding]} ${className}`}
    >
      {children}
    </View>
  );
}
