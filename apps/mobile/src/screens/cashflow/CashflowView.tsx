// Pure cashflow screen. The hook gives exact Money values and the chart's exact value labels.
import { BarChart, Money as MoneyValue } from "@cashu/ui/native";
import { FlashList } from "@shopify/flash-list";
import { Text, View } from "react-native";
import { CurrencyPicker } from "../controls/CurrencyPicker";
import { PeriodPicker } from "../controls/PeriodPicker";
import type { CashflowViewProps } from "../money-contracts";
import { S } from "./Cashflow.strings";

export function CashflowView(props: CashflowViewProps) {
  return (
    <View className="flex-1 bg-surface">
      <FlashList
        data={props.rows}
        keyExtractor={(row) => row.label}
        renderItem={({ item }) => (
          <View className="mx-4 mb-3 gap-2 rounded-lg bg-surface-raised p-4">
            <Text role="heading" className="text-title font-strong text-fg">
              {item.label}
            </Text>
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-body text-fg-secondary">{S.income}</Text>
              <MoneyValue value={item.income} />
            </View>
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-body text-fg-secondary">{S.expense}</Text>
              <MoneyValue value={item.expense} />
            </View>
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-body font-strong text-fg">{S.net}</Text>
              <MoneyValue value={item.net} weight="strong" />
            </View>
          </View>
        )}
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
            {!props.empty && (
              <View className="rounded-lg bg-surface-raised p-4">
                <BarChart {...props.chart} />
              </View>
            )}
          </View>
        }
        ListEmptyComponent={<Text className="px-4 text-body text-fg-secondary">{S.noData}</Text>}
      />
    </View>
  );
}
