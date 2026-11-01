// One transaction row of the benchmark list: title, date and category, amount in its tone. Token
// classes only (packages/ui theme); value components share locale and privacy with every screen.
import type { Money as MoneyValue } from "@cashu/domain";
import { DateText, Money } from "@cashu/ui";
import { Text, View } from "react-native";

export interface TxItem {
  readonly id: number;
  readonly title: string;
  readonly date: string;
  readonly category: string;
  readonly amount: MoneyValue;
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
          <DateText value={item.date} size="caption" tone="muted" /> · {item.category}
        </Text>
      </View>
      <Money value={item.amount} weight="strong" tone={item.negative ? "negative" : "positive"} />
    </View>
  );
}
