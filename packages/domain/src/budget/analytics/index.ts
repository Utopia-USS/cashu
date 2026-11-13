/** Public API of the budget analytics sub-folder (Python `analytics.py`, `monthclose.py`, `investing_link.py`, `settings.py`). */

export {
  type BudgetAccount,
  type BudgetBook,
  type BudgetTxn,
  bookOwnIbans,
  budgetBaseCurrency,
  type FlowFields,
  inPeriod,
  isFlow,
  monthLabel,
  NON_SPENDING_CATEGORIES,
  type Period,
} from "./book.js";
export {
  averageSavingsRate,
  budgetCurrencies,
  type CurrencyUse,
  cashflowCoverageStart,
  type MonthlyCashflow,
  monthBounds,
  monthlyCashflow,
  referenceDate,
  wholeMonths,
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
  type AccountFirstBooking,
  type CurrencyCountRow,
  categoryNormFromRows,
  coverageStartFromRows,
  currenciesFromRows,
  type MonthAggregates,
  type MonthCatRow,
  type MonthDayRow,
  monthlyCashflowFromRows,
  spendingByCategoryFromRows,
  usualPayDayFromRows,
  usualToDateFromRows,
} from "./monthAggregates.js";
export {
  type CurrencyClose,
  defaultMonth,
  type MonthClose,
  type MonthCloseOptions,
  type MonthParse,
  monthClose,
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
  normMonths,
  type SubscriptionsSummary,
  subscriptionsSummary,
} from "./overview.js";
export {
  NEW_RECURRING_MIN_OCCURRENCES,
  NEW_RECURRING_WINDOW_DAYS,
  type PayeeChange,
  type PayeeChangesInput,
  type PayeeCharge,
  type PayeeChargeHistory,
  PRICE_UP_MIN_OLDER_CHARGES,
  PRICE_UP_MIN_SHARE,
  payeeChanges,
} from "./payeeChanges.js";
export {
  type PayeeHit,
  type PayeeSummary,
  type PayeeYearRow,
  payeeSummary,
} from "./payeeHistory.js";
export {
  categoryNorm,
  type MonthProjection,
  type MonthProjectionInput,
  monthProjection,
  usualPayDay,
  usualToDate,
} from "./projection.js";
export {
  activeRecurring,
  groupSeries,
  type RecurringSeries,
  recurringPayments,
  recurringSeries,
  SERIES_DATE_SLACK_DAYS,
  subscriptionExclusions,
} from "./recurring.js";
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
export {
  type AccountBalance,
  type InstallmentDue,
  isMonthlyGap,
  MONTHLY_GAP_MAX_DAYS,
  MONTHLY_GAP_MIN_DAYS,
  nextChargeDate,
  type PlannedOutflow,
  type RecurringCharge,
  UPCOMING_GRACE_DAYS,
  UPCOMING_HORIZON_DAYS,
  type Upcoming,
  type UpcomingAccount,
  type UpcomingInput,
  type UpcomingRow,
  upcomingCharges,
} from "./upcoming.js";
