// The old segmented currency switch (currency.tsx CurrencySwitch): only with data in two or more currencies.
import { Seg } from "@cashu/ui";
import type { BudgetCurrency } from "./budgetCurrency.js";

export function CurrencySwitch({ bc }: { bc: BudgetCurrency }) {
  if (bc.codes.length < 2) return null;
  return (
    <Seg<string>
      items={bc.codes.map((c) => [c, c] as const)}
      value={bc.currency}
      onChange={bc.setCurrency}
    />
  );
}
