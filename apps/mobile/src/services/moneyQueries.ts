// Stable read models for the mobile money screens. The caller supplies the actual price context;
// null is the store's documented last-trade valuation mode, not a live market quote.
import {
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
} from "@cashu/store/budget/queries";
import { overviewQueries } from "@cashu/store/overview";

export type MoneyQueryContext = Parameters<typeof overviewQueries>[0];

export function createMoneyQueries(context: MoneyQueryContext) {
  return {
    overview: overviewQueries(context),
    budget: {
      currencies: budgetScreenCurrencies,
      cashflow: budgetScreenCashflow,
      spending: budgetScreenSpending,
    },
  } as const;
}

export type MoneyQueries = ReturnType<typeof createMoneyQueries>;
