// The budget's currency choice shared by the budget tabs (ab24ab6 modules/budget/currency.tsx): the requested
// currency (the route's `currency` search value) when the profile has data in it, else the base currency when it
// has data (or there is none at all), else the most used one. Native: budgetScreenCurrencies of this vault.
import type { IsoDate } from "@cashu/domain";
import { budgetScreenCurrencies } from "@cashu/store/budget/queries";
import { useQuery } from "@cashu/store-react";

export interface BudgetCurrency {
  /** The currency the budget views show. */
  currency: string;
  /** Currencies with data (base first); the switch shows from two. */
  codes: readonly string[];
  /** The profile's base currency. */
  base: string;
  setCurrency(currency: string): void;
}

export function useBudgetCurrency(args: {
  today: IsoDate;
  requested?: string | undefined;
  onChange(currency: string): void;
}): BudgetCurrency {
  const info = useQuery(budgetScreenCurrencies, { today: args.today });
  const codes = info.currencies.map((c) => c.currency);
  const currency =
    args.requested && codes.includes(args.requested)
      ? args.requested
      : codes.includes(info.baseCurrency) || codes.length === 0
        ? info.baseCurrency
        : (codes[0] ?? info.baseCurrency);
  return { currency, codes, base: info.baseCurrency, setCurrency: args.onChange };
}
