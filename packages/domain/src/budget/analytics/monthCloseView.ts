/**
 * The month close as the API shows it (`monthclose.as_dict`): category lists largest first, the
 * cushion summary and the comparison with the planned contribution. Amounts stay `Decimal` here; the
 * API layer writes them as JSON numbers (Python `float(value)`).
 */

import type { UiLang } from "../../core/index.js";
import { ZERO_00 } from "../../core/index.js";
import type { Decimal } from "../../decimal.js";
import { categoryLabel } from "../categorize/index.js";
import type { CurrencyClose, MonthClose } from "./monthClose.js";

export interface CategoryAmount {
  readonly category: string;
  readonly label: string;
  readonly amount: Decimal;
}

export interface CurrencyCloseView {
  readonly currency: string;
  readonly income: Decimal;
  readonly spending: Decimal;
  readonly surplus: Decimal;
  readonly cushionTopUp: Decimal;
  readonly suggestedTransfer: Decimal;
  readonly transactions: number;
  readonly incomeByCategory: readonly CategoryAmount[];
  readonly spendingByCategory: readonly CategoryAmount[];
}

export interface CushionView {
  readonly enabled: true;
  readonly currency: string;
  readonly target: Decimal | null;
  readonly targetSource: "amount" | "months";
  readonly targetMonths: number | null;
  readonly averageSpending: Decimal | null;
  readonly balance: Decimal;
  readonly missing: Decimal;
  readonly topUp: Decimal;
  readonly reached: boolean;
  readonly accounts: readonly { readonly id: string; readonly name: string }[];
}

export interface InvestingView {
  readonly enabled: true;
  readonly strategyState: string | null;
  readonly planned: {
    readonly amount: Decimal;
    readonly currency: string;
    readonly dayOfMonth: number | null;
  } | null;
  readonly comparison: {
    readonly currency: string;
    readonly hasData: boolean;
    readonly surplus: Decimal;
    readonly suggestedTransfer: Decimal;
    readonly difference: Decimal;
    readonly status: "covered" | "short";
  } | null;
}

export interface MonthCloseView {
  readonly month: string;
  readonly complete: boolean;
  readonly baseCurrency: string;
  readonly firstMonth: string | null;
  readonly lastMonth: string | null;
  readonly currencies: readonly CurrencyCloseView[];
  readonly cushion: CushionView | null;
  readonly investing: InvestingView | null;
}

/** `_categories`: largest first, equal amounts in first-seen order. */
function categories(values: ReadonlyMap<string, Decimal>, lang: UiLang): CategoryAmount[] {
  return [...values]
    .sort((a, b) => b[1].compare(a[1]))
    .map(([category, amount]) => ({ category, label: categoryLabel(category, lang), amount }));
}

function currencyView(c: CurrencyClose, lang: UiLang): CurrencyCloseView {
  return {
    currency: c.currency,
    income: c.income,
    spending: c.spending,
    surplus: c.surplus,
    cushionTopUp: c.cushionTopUp,
    suggestedTransfer: c.suggestedTransfer,
    transactions: c.transactions,
    incomeByCategory: categories(c.incomeByCategory, lang),
    spendingByCategory: categories(c.spendingByCategory, lang),
  };
}

function investingView(close: MonthClose): InvestingView | null {
  if (!close.investmentsEnabled) return null;
  const plan = close.planned;
  if (plan === null) return { enabled: true, strategyState: null, planned: null, comparison: null };
  if (plan.amount === null || !plan.currency) {
    return { enabled: true, strategyState: plan.strategyState, planned: null, comparison: null };
  }
  const currency = plan.currency;
  const cc = close.currencies.find((c) => c.currency === currency);
  const surplus = cc?.surplus ?? ZERO_00;
  const suggested = cc?.suggestedTransfer ?? ZERO_00;
  return {
    enabled: true,
    strategyState: plan.strategyState,
    planned: { amount: plan.amount, currency, dayOfMonth: plan.dayOfMonth },
    comparison: {
      currency,
      hasData: cc !== undefined,
      surplus,
      suggestedTransfer: suggested,
      difference: suggested.sub(plan.amount),
      status: suggested.gte(plan.amount) ? "covered" : "short",
    },
  };
}

/** `as_dict`: the month close as the `GET /budget/month-close` view (labels in `lang`). */
export function monthCloseView(close: MonthClose, lang: UiLang = "pl"): MonthCloseView {
  const c = close.cushion;
  return {
    month: close.label,
    complete: close.complete,
    baseCurrency: close.baseCurrency,
    firstMonth: close.firstMonth,
    lastMonth: close.lastMonth,
    currencies: close.currencies.map((cc) => currencyView(cc, lang)),
    cushion:
      c === null
        ? null
        : {
            enabled: true,
            currency: c.currency,
            target: c.target,
            targetSource: c.targetSource,
            targetMonths: c.targetMonths,
            averageSpending: c.averageSpending,
            balance: c.balance,
            missing: c.missing,
            topUp: c.topUp,
            reached: c.target !== null && c.missing.isZero(),
            accounts: c.accounts.map((a) => ({ id: a.id, name: a.name })),
          },
    investing: investingView(close),
  };
}
