import { useState } from "react";
import { View } from "react-native";
import type { PeriodChoice } from "../money-contracts";
import { AccountPicker } from "./AccountPicker";
import { CurrencyPicker } from "./CurrencyPicker";
import { PeriodPicker } from "./PeriodPicker";

function ControlsGallery({ empty = false }: { empty?: boolean }) {
  const [currency, onCurrencyChange] = useState("PLN");
  const [period, onPeriodChange] = useState<PeriodChoice>({ kind: "all" });
  const [account, onPicked] = useState<string | null>(null);
  return (
    <View className="gap-4 bg-surface p-4">
      <CurrencyPicker
        currencies={empty ? [] : ["PLN", "EUR"]}
        currency={currency}
        onCurrencyChange={onCurrencyChange}
      />
      <AccountPicker
        options={empty ? [] : [{ gid: "synthetic-checking", name: "Synthetic checking" }]}
        selected={account}
        onPicked={onPicked}
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
export const RetainedHistory = { args: { empty: false } };
export const Empty = { args: { empty: true } };
