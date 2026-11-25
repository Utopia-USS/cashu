// The frame every review card shares (prototype `.dcard`): the eyebrow and the "n / m" step on top, the
// card's title, then its body in a scroll area (a long decide card scrolls inside the stage), and an
// optional quiet source line at the foot.
import { NoteLine } from "@cashu/ui/native";
import type { ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";

export function CardShell({
  eyebrow,
  step,
  title,
  source,
  children,
}: {
  eyebrow: string;
  step?: string;
  title: string;
  source?: string;
  children?: ReactNode;
}) {
  return (
    <View className="flex-1 overflow-hidden rounded-widget border border-border bg-surface-raised">
      <ScrollView className="flex-1" contentContainerClassName="gap-3 p-5">
        <View className="flex-row items-center justify-between gap-2">
          <Text numberOfLines={1} className="shrink text-caption font-demi text-fg-muted">
            {eyebrow}
          </Text>
          {step !== undefined && (
            <Text className="text-caption text-fg-muted tabular-nums">{step}</Text>
          )}
        </View>
        <Text role="heading" className="text-title font-strong text-fg">
          {title}
        </Text>
        {children}
        {source !== undefined && <NoteLine icon="laptop">{source}</NoteLine>}
      </ScrollView>
    </View>
  );
}
