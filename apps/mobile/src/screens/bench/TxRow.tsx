// One transaction row of the benchmark list: title, date and category, amount in its tone. Token
// classes only (packages/ui theme); the shared ListRow / Money components land with the UI port.
import { Text, View } from "react-native";

export interface TxItem {
  readonly id: number;
  readonly title: string;
  readonly subtitle: string;
  readonly amount: string;
  readonly negative: boolean;
}

export function TxRow({ item }: { item: TxItem }) {
  return (
    <View className="h-row flex-row items-center gap-3 border-b border-border bg-surface-raised px-4 py-3">
      <View className="min-w-0 shrink grow">
        <Text numberOfLines={1} className="text-body font-strong text-fg">
          {item.title}
        </Text>
        <Text numberOfLines={1} className="text-caption text-fg-muted">
          {item.subtitle}
        </Text>
      </View>
      <Text
        className={`text-body font-strong tabular-nums ${item.negative ? "text-negative" : "text-positive"}`}
      >
        {item.amount}
      </Text>
    </View>
  );
}
