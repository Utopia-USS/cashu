// An empty phone list or tile: a centred icon, title, an optional body and an optional action.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { Icon, type IconName } from "../icons/Icon.js";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  body?: string;
  /** Usually a `Button`. */
  action?: ReactNode;
}

/** Centred empty state. */
export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <View className="items-center gap-2 px-6 py-8">
      {icon !== undefined && <Icon name={icon} size={24} className="text-fg-muted" />}
      <View accessible className="items-center gap-1">
        <Text className="text-center text-title font-strong text-fg">{title}</Text>
        {body !== undefined && (
          <Text className="text-center text-caption text-fg-muted">{body}</Text>
        )}
      </View>
      {action !== undefined && <View className="mt-2">{action}</View>}
    </View>
  );
}
