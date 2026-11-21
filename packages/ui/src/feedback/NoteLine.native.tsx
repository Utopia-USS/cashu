// The "where this comes from" line under a phone tile: a 16 pt muted icon and a muted caption.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Icon, type IconName } from "../icons/Icon.js";

export interface NoteLineProps {
  icon: IconName;
  children: ReactNode;
}

/** A quiet source / provenance note. */
export function NoteLine({ icon, children }: NoteLineProps) {
  return (
    <View accessible accessibilityRole="text" className="flex-row items-start gap-1.5">
      <Icon name={icon} size={16} className="text-fg-muted" />
      <Text className="shrink text-caption text-fg-muted">{children}</Text>
    </View>
  );
}
