// Stable read models for the mobile money screens. The caller supplies the actual price context;
// null is the store's documented last-trade valuation mode, not a live market quote. Only the
// net-worth part of the overview (`@cashu/store/overview/networth`) and the budget screen queries:
// the full overview and budget query barrels carry the desktop widgets and the statement import.
import {
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
} from "@cashu/store/budget/screen";
import { netWorthQueries } from "@cashu/store/overview/networth";

export type MoneyQueryContext = Parameters<typeof netWorthQueries>[0];

export function createMoneyQueries(context: MoneyQueryContext) {
  return {
    overview: netWorthQueries(context),
    budget: {
      currencies: budgetScreenCurrencies,
      cashflow: budgetScreenCashflow,
      spending: budgetScreenSpending,
    },
  } as const;
}

export type MoneyQueries = ReturnType<typeof createMoneyQueries>;
