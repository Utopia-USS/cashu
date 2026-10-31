// The list benchmark: a FlashList v2 over the store's transactions, the S50 scroll and mount runs.
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import type { ReactNode, RefObject } from "react";
import { Pressable, Text, View } from "react-native";
import { S } from "./Bench.strings";
import { type TxItem, TxRow } from "./TxRow";

export interface BenchViewProps {
  readonly items: readonly TxItem[];
  readonly listRef?: RefObject<FlashListRef<TxItem> | null>;
  readonly busy: boolean;
  readonly report: readonly string[];
  readonly onScroll4k: () => void;
  readonly onScroll12k: () => void;
  readonly onMount500: () => void;
  /** The mount benchmark's off-screen batch while it runs. */
  readonly overlay?: ReactNode;
}

function Action({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      role="button"
      aria-label={label}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      className="rounded-md bg-accent-muted px-3 py-2"
    >
      <Text className="text-caption font-strong text-accent">{label}</Text>
    </Pressable>
  );
}

export function BenchView(props: BenchViewProps) {
  const { items, listRef, busy, report, onScroll4k, onScroll12k, onMount500, overlay } = props;
  return (
    <View className="flex-1 bg-surface">
      <View className="gap-2 px-4 py-3">
        <Text className="text-caption text-fg-muted">{S.rows(String(items.length))}</Text>
        <View className="flex-row gap-2">
          <Action label={S.scroll4k} onPress={onScroll4k} disabled={busy} />
          <Action label={S.scroll12k} onPress={onScroll12k} disabled={busy} />
          <Action label={S.mount500} onPress={onMount500} disabled={busy} />
        </View>
        {report.map((line) => (
          <Text key={line} className="text-caption tabular-nums text-fg-secondary">
            {line}
          </Text>
        ))}
      </View>
      <View className="flex-1">
        <FlashList
          ref={listRef}
          data={items}
          keyExtractor={(t) => String(t.id)}
          renderItem={({ item }) => <TxRow item={item} />}
        />
      </View>
      {overlay}
    </View>
  );
}
