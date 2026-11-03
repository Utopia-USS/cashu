import { useState } from "react";
import { View } from "react-native";
import type { PeriodChoice } from "../money-contracts";
import { CurrencyPicker } from "./CurrencyPicker";
import { PeriodPicker } from "./PeriodPicker";

function ControlsGallery({ empty = false }: { empty?: boolean }) {
  const [currency, onCurrencyChange] = useState("PLN");
  const [period, onPeriodChange] = useState<PeriodChoice>({ kind: "all" });
  return (
    <View className="gap-4 bg-surface p-4">
      <CurrencyPicker
        currencies={empty ? [] : ["PLN", "EUR"]}
        currency={currency}
        onCurrencyChange={onCurrencyChange}
      />
      <PeriodPicker
        period={period}
        periodBounds={empty ? null : { first: "2024-11-01", last: "2026-03-31" }}
        onPeriodChange={onPeriodChange}
      />
    </View>
  );
}

export default { title: "Mobile/Native controls", component: ControlsGallery };
export const RetainedHistory = {};
export const Empty = { args: { empty: true } };
