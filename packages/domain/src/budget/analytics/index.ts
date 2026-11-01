/** Public API of the budget analytics sub-folder (Python `analytics.py`, `monthclose.py`, `investing_link.py`, `settings.py`). */

export {
  type BudgetAccount,
  type BudgetBook,
  type BudgetTxn,
  budgetBaseCurrency,
  inPeriod,
  isFlow,
  monthLabel,
  NON_SPENDING_CATEGORIES,
  type Period,
} from "./book.js";
export {
  budgetCurrencies,
  type CurrencyUse,
  type MonthlyCashflow,
  monthBounds,
  monthlyCashflow,
  referenceDate,
} from "./cashflow.js";
export {
  averageSpending,
  CUSHION_AVERAGE_MONTHS,
  type CushionEnv,
  type CushionState,
  cushionAccounts,
  cushionLevel,
  cushionState,
  type LatestBalances,
} from "./cushion.js";
export {
  type PlannedContribution,
  plannedContribution,
  type StrategyPlanSource,
  type StrategyState,
} from "./investingLink.js";
export {
  type CurrencyClose,
  defaultMonth,
  type MonthClose,
  type MonthCloseOptions,
  type MonthParse,
  monthClose,
  monthFlows,
  parseMonth,
  shiftMonth,
} from "./monthClose.js";
export {
  type CategoryAmount,
  type CurrencyCloseView,
  type CushionView,
  type InvestingView,
  type MonthCloseView,
  monthCloseView,
} from "./monthCloseView.js";
export {
  closedMonthNorm,
  type MonthNorm,
  type MonthSummary,
  monthSummary,
  NORM_MONTHS,
  type SubscriptionsSummary,
  subscriptionsSummary,
} from "./overview.js";
export { activeRecurring, recurringPayments, subscriptionExclusions } from "./recurring.js";
export {
  type BudgetSettings,
  type CushionAccountRef,
  type CushionAccountsProblem,
  type CushionSettings,
  checkCushionAccounts,
  cushionAccountsError,
  defaultBudgetSettings,
  loadBudgetSettings,
  MAX_TARGET_MONTHS,
  parseBudgetSettings,
  type SettingsParse,
} from "./settings.js";
export {
  type CategorySpend,
  type CategoryTxnOptions,
  type CategoryTxnRow,
  categoryTransactions,
  spendingByCategory,
  txnDetails,
} from "./spending.js";
