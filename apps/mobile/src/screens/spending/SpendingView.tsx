// Pure spending screen: exact Money rows and the prebuilt share chart arrive from the screen hook.
import { Donut, Money as MoneyValue } from "@cashu/ui";
import { FlashList } from "@shopify/flash-list";
import { Text, View } from "react-native";
import { CurrencyPicker } from "../controls/CurrencyPicker";
import { PeriodPicker } from "../controls/PeriodPicker";
import type { SpendingViewProps } from "../money-contracts";
import { S } from "./Spending.strings";

export function SpendingView(props: SpendingViewProps) {
  return (
    <FlashList
      className="flex-1 bg-surface"
      data={props.rows}
      keyExtractor={(row) => row.key}
      ListHeaderComponent={
        <View className="gap-4 p-4">
          <Text role="heading" className="text-headline font-strong text-fg">
            {S.title}
          </Text>
          <CurrencyPicker
            currencies={props.currencies}
            currency={props.currency}
            onCurrencyChange={props.onCurrencyChange}
          />
          <PeriodPicker
            period={props.period}
            periodBounds={props.periodBounds}
            onPeriodChange={props.onPeriodChange}
          />
          <View className="gap-2 rounded-lg bg-surface-raised p-4">
            <Text className="text-caption text-fg-secondary">{S.total}</Text>
            <MoneyValue value={props.total} size="display" weight="strong" />
            {!props.empty && <Donut {...props.chart} />}
          </View>
        </View>
      }
      ListEmptyComponent={<Text className="px-4 py-3 text-body text-fg-secondary">{S.noData}</Text>}
      renderItem={({ item }) => (
        <View className="mx-4 flex-row items-center justify-between gap-3 border-b border-border py-3">
          <Text className="flex-1 text-body text-fg">{item.label}</Text>
          <MoneyValue value={item.amount} />
        </View>
      )}
    />
  );
}
