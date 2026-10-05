// Budget module endpoints (profile-scoped). Shapes mirror the server JSON. Every view takes an
// explicit currency (the server defaults to the profile's base currency, never sums currencies).
import { j, jpost, jput, pp } from "../../core/api";

export interface CashflowRow { label: string; income: number; expense: number; net: number }
export interface SpendRow { category: string; label: string; amount: number }

export interface DrillRow {
  id: number;
  date: string;
  amount: number;
  currency: string;
  merchant: string;
  merchant_key: string;
  details: string | null;
  counterparty: string | null;
  category: string;
  category_source: string | null;
  account: string | null;
}

export interface RecurringItem {
  payee: string; amount: number; currency: string; count: number; gap_days: number; last: string; active: boolean;
}

const withCurrency = (q: string, currency?: string | null) =>
  currency ? `${q}${q.includes("?") ? "&" : "?"}currency=${encodeURIComponent(currency)}` : q;

export const getCashflow = (slug: string, months = 240, currency?: string | null) =>
  j<CashflowRow[]>(pp(slug, withCurrency(`/cashflow?months=${months}`, currency)));
export const getRecurring = (slug: string) => j<{ items: RecurringItem[] }>(pp(slug, "/recurring"));
export const getSpending = (slug: string, q: string, currency?: string | null) =>
  j<SpendRow[]>(pp(slug, withCurrency("/spending" + q, currency)));

// ---- currencies, month close, budget settings --------------------------------------------------
export interface CurrencyUse { currency: string; transactions: number; first: string; last: string }
/** `default`: the base currency when it has data, else the most used one (the picker's start). */
export interface BudgetCurrencies { base: string; default: string; currencies: CurrencyUse[] }

export interface CategoryAmount { category: string; label: string; amount: number }
export interface CurrencyClose {
  currency: string;
  income: number;
  spending: number;
  surplus: number;
  cushion_top_up: number;
  suggested_transfer: number;
  transactions: number;
  income_by_category: CategoryAmount[];
  spending_by_category: CategoryAmount[];
}
export interface CushionState {
  enabled: boolean;
  currency: string;
  target: number | null;
  target_source: "amount" | "months";
  target_months: number | null;
  average_spending: number | null;
  balance: number;
  missing: number;
  top_up: number;
  reached: boolean;
  accounts: { id: number; name: string }[];
}
export interface InvestingLink {
  enabled: boolean;
  /** missing | valid | partial | invalid (investments strategy files). */
  strategy_state: string | null;
  planned: { amount: number; currency: string; day_of_month: number | null } | null;
  comparison: {
    currency: string;
    has_data: boolean;
    surplus: number;
    suggested_transfer: number;
    difference: number;
    status: "covered" | "short";
  } | null;
}
export interface MonthClose {
  month: string;
  complete: boolean;
  base_currency: string;
  first_month: string | null;
  last_month: string | null;
  currencies: CurrencyClose[];
  cushion: CushionState | null;
  /** null when the investments module is off for the profile. */
  investing: InvestingLink | null;
}
export interface CushionSettings {
  enabled: boolean;
  currency: string | null;
  target_amount: number | null;
  target_months: number | null;
  account_ids: number[];
  monthly_max: number | null;
}
export interface BudgetSettings { cushion: CushionSettings }

export const getBudgetCurrencies = (slug: string) => j<BudgetCurrencies>(pp(slug, "/budget/currencies"));
export const getMonthClose = (slug: string, month?: string | null) =>
  j<MonthClose>(pp(slug, `/budget/month-close${month ? `?month=${encodeURIComponent(month)}` : ""}`));
export const getBudgetSettings = (slug: string) => j<BudgetSettings>(pp(slug, "/budget/settings"));
export const putBudgetSettings = (slug: string, body: BudgetSettings) =>
  jput<BudgetSettings>(pp(slug, "/budget/settings"), body);

export const postTxnCategory = (slug: string, id: number, category: string) =>
  jpost<{ ok: boolean }>(pp(slug, `/transactions/${id}/category`), { category });
export const postMerchantCategory = (slug: string, merchant_key: string, category: string) =>
  jpost<{ updated: number }>(pp(slug, "/merchant-category"), { merchant_key, category });

export const drillUrl = (
  slug: string,
  key: string,
  opts: { sort: string; order: string; currency: string; year?: number | null; month?: number | null; quarter?: number | null },
): string => {
  const p = new URLSearchParams({ sort: opts.sort, order: opts.order, currency: opts.currency });
  if (opts.year) p.set("year", String(opts.year));
  if (opts.month) p.set("month", String(opts.month));
  if (opts.quarter) p.set("quarter", String(opts.quarter));
  return pp(slug, `/category/${encodeURIComponent(key)}/transactions?${p.toString()}`);
};
