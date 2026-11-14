// Building blocks of the debug screens: a titled card, a label / value line, a full-width button.
// Token classes only; they move to packages/ui if a second screen needs them.
import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View className="gap-1 rounded-lg bg-surface-raised p-4">
      <Text role="heading" className="text-title font-strong text-fg">
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Line({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative";
}) {
  const valueClass =
    tone === "positive" ? "text-positive" : tone === "negative" ? "text-negative" : "text-fg";
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="shrink text-body text-fg-secondary">{label}</Text>
      <Text className={`text-body font-strong tabular-nums ${valueClass}`}>{value}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled === true}
      disabled={disabled}
      onPress={onPress}
      className="mt-2 items-center rounded-md bg-accent px-4 py-3"
    >
      <Text className="text-body font-strong text-fg-inverse">{label}</Text>
    </Pressable>
  );
}
