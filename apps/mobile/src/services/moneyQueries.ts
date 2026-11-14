// Stable read models for the mobile money screens and the shell (the incognito banana scale). The
// caller supplies the actual price context; null is the store's documented last-trade valuation mode,
// not a live market quote. Only the
// net-worth part of the overview (`@cashu/store/overview/networth`, `/overview/accounts`), the loan
// screen queries and the budget screen queries: the full overview and budget query barrels carry the
// desktop widgets and the statement import. The investments screen queries read the phone's sources
// (`investments.ts`); without them every investments read is unavailable.
import {
  budgetCategoryOptions,
  budgetSearch,
  budgetTransactionDetail,
  budgetTransactions,
} from "@cashu/store/budget/companion";
import { budgetScreenCurrencies, budgetScreenSpending } from "@cashu/store/budget/screen";
import { researchScreenQueries } from "@cashu/store/investments/research-screen";
import { reviewDueQuery, reviewScreenQueries } from "@cashu/store/investments/review-screen";
import { investmentDesktopQueries, strategyReaderQuery } from "@cashu/store/investments/screen";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import { loanSchedule, loansScreen } from "@cashu/store/loans/screen";
import { accountsQuery, assetsQuery } from "@cashu/store/overview/accounts";
import { bananaScaleQuery } from "@cashu/store/overview/bananas";
import { overviewCashWallet } from "@cashu/store/overview/cash";
import { companionQueries } from "@cashu/store/overview/companion";
import { netWorthQueries } from "@cashu/store/overview/networth";
import type { PhoneInvestmentSources } from "./investments";

export type MoneyQueryContext = Parameters<typeof netWorthQueries>[0];

export function createMoneyQueries(
  context: MoneyQueryContext,
  sources: Partial<PhoneInvestmentSources> = {},
) {
  const desktop = investmentDesktopQueries(sources);
  const research = researchScreenQueries(sources);
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
    companion: companionQueries({}, sources),
    activity: {
      transactions: budgetTransactions,
      search: budgetSearch,
      detail: budgetTransactionDetail,
      categories: budgetCategoryOptions,
    },
    investments: {
      portfolio: desktop.portfolio,
      asset: desktop.asset,
      signals: signalsQueries(sources).screen,
      review: reviewScreenQueries(sources).screen,
      research: { note: research.note, asset: research.asset, notes: research.notes },
      strategy: strategyReaderQuery(sources),
      reviewDue: reviewDueQuery,
    },
  } as const;
}

export type MoneyQueries = ReturnType<typeof createMoneyQueries>;
