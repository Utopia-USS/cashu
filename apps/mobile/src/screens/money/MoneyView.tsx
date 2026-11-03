// Pure net-worth screen: exact Money, one selected currency and a chart model supplied by the hook.
import { LineChart, Money as MoneyValue } from "@cashu/ui";
import { Button, Row } from "@expo/ui";
import { ScrollView, Text, View } from "react-native";
import { ControlHost } from "../controls/ControlHost";
import { CurrencyPicker } from "../controls/CurrencyPicker";
import type { MoneyViewProps } from "../money-contracts";
import { S } from "./Money.strings";

export function MoneyView(props: MoneyViewProps) {
  return (
    <ScrollView className="flex-1 bg-surface">
      <View className="gap-4 p-4">
        <Text role="heading" className="text-headline font-strong text-fg">
          {S.title}
        </Text>
        <CurrencyPicker
          currencies={props.currencies}
          currency={props.currency}
          onCurrencyChange={props.onCurrencyChange}
        />
        <View className="gap-2 rounded-lg bg-surface-raised p-4">
          <Text className="text-caption text-fg-secondary">{S.value}</Text>
          <MoneyValue value={props.total} size="display" weight="strong" />
        </View>
        {props.empty ? (
          <Text className="text-body text-fg-secondary">{S.noData}</Text>
        ) : (
          <View className="gap-2 rounded-lg bg-surface-raised p-4">
            <Text className="text-title font-strong text-fg">{S.history}</Text>
            <LineChart {...props.history} />
          </View>
        )}
        <ControlHost>
          <Row>
            <Button label={S.cashflow} onPress={props.onCashflow} />
            <Button label={S.spending} onPress={props.onSpending} />
          </Row>
        </ControlHost>
      </View>
    </ScrollView>
  );
}
