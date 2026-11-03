import { Picker } from "@expo/ui";
import { Text, View } from "react-native";
import { ControlHost } from "./ControlHost";
import { S } from "./Controls.strings";

export interface CurrencyPickerProps {
  readonly currencies: readonly string[];
  readonly currency: string;
  readonly onCurrencyChange: (currency: string) => void;
  readonly testID?: string;
}

export function CurrencyPicker({
  currencies,
  currency,
  onCurrencyChange,
  testID = "money-currency",
}: CurrencyPickerProps) {
  return (
    <View className="gap-2">
      <Text className="text-body text-fg-secondary">{S.currency}</Text>
      {currencies.length === 0 ? (
        <Text className="text-body text-fg-secondary">{S.noCurrencies}</Text>
      ) : (
        <ControlHost>
          <Picker
            selectedValue={currency}
            enabled={currencies.length > 1}
            testID={testID}
            onValueChange={(next) => {
              if (next !== currency && currencies.includes(next)) onCurrencyChange(next);
            }}
          >
            {currencies.map((value) => (
              <Picker.Item key={value} value={value} label={value} />
            ))}
          </Picker>
        </ControlHost>
      )}
    </View>
  );
}
