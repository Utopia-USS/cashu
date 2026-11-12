// Stable read models for the mobile money screens and the shell (the incognito banana scale). The
// caller supplies the actual price context; null is the store's documented last-trade valuation mode,
// not a live market quote. Only the
// net-worth part of the overview (`@cashu/store/overview/networth`, `/overview/accounts`), the loan
// screen queries and the budget screen queries: the full overview and budget query barrels carry the
// desktop widgets and the statement import.
import {
  budgetCategoryOptions,
  budgetSearch,
  budgetTransactionDetail,
  budgetTransactions,
} from "@cashu/store/budget/companion";
import { budgetScreenCurrencies, budgetScreenSpending } from "@cashu/store/budget/screen";
import { loanSchedule, loansScreen } from "@cashu/store/loans/screen";
import { accountsQuery, assetsQuery } from "@cashu/store/overview/accounts";
import { bananaScaleQuery } from "@cashu/store/overview/bananas";
import { overviewCashWallet } from "@cashu/store/overview/cash";
import { companionQueries } from "@cashu/store/overview/companion";
import { netWorthQueries } from "@cashu/store/overview/networth";

export type MoneyQueryContext = Parameters<typeof netWorthQueries>[0];

export function createMoneyQueries(context: MoneyQueryContext) {
  return {
    overview: { ...netWorthQueries(context), bananaScale: bananaScaleQuery(context) },
    holdings: {
      accounts: accountsQuery(context),
      assets: assetsQuery(context),
    },
    loans: { screen: loansScreen, schedule: loanSchedule },
    budget: {
      currencies: budgetScreenCurrencies,
      spending: budgetScreenSpending,
    },
    cash: { wallet: overviewCashWallet },
    companion: companionQueries(),
    activity: {
      transactions: budgetTransactions,
      search: budgetSearch,
      detail: budgetTransactionDetail,
      categories: budgetCategoryOptions,
    },
  } as const;
}

export type MoneyQueries = ReturnType<typeof createMoneyQueries>;
