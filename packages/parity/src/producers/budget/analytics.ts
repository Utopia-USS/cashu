/**
 * Producer of `budget.analytics` (`parity/python/checks/budget.py:analytics`): per profile, the base
 * currency, the budget currencies, the reference date; per currency the monthly cashflow (with and
 * without internal moves), spending by category (all time, the last three months, the quarter and
 * the year of the reference date), the drill-down of every category (by date, and the top three by
 * amount); the recurring and active recurring payments and the not-a-subscription categories.
 *
 * Every number comes from `@cashu/domain` budget analytics over the stored rows (`book.ts`); the
 * recurring list's engine context is the categorization producer's (own IBANs of every account, the
 * profile's merchant rules and loan payment patterns, the modules' text rules).
 */

import { budget, core } from "@cashu/domain";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { budgetBook } from "./book.ts";

const REGISTRY = core.builtinRegistry();
const NOT_SUBSCRIPTION = budget.subscriptionExclusions(REGISTRY);
const MODULE_TEXT_RULES = core.textRules(REGISTRY);

function cashflowOut(rows: readonly budget.MonthlyCashflow[]): OutValue {
  return rows.map((r) => ({
    year: BigInt(r.year),
    month: BigInt(r.month),
    label: r.label,
    income: r.income,
    expense: r.expense,
    net: r.net,
  }));
}

function spendOut(rows: readonly budget.CategorySpend[]): OutValue {
  return rows.map((r) => ({ category: r.category, label: r.label, amount: r.amount }));
}

function drillOut(rows: readonly budget.CategoryTxnRow[]): OutValue {
  return rows.map((r) => ({
    id: r.key,
    date: r.date,
    amount: r.amount,
    currency: r.currency,
    merchant: r.merchant,
    merchant_key: r.merchantKey,
    details: r.details,
    counterparty: r.counterparty,
    category: r.category,
    category_source: r.categorySource,
    account: r.account,
  }));
}

function recurringOut(rows: readonly budget.RecurringCandidate[]): OutValue {
  return rows.map((c) => ({
    counterparty: c.counterparty,
    typical_amount: c.typicalAmount,
    occurrences: BigInt(c.occurrences),
    months_covered: BigInt(c.monthsCovered),
    median_gap_days: BigInt(c.medianGapDays),
    last_date: c.lastDate,
    currency: c.currency,
  }));
}

function periodsOut(book: budget.BudgetBook, currency: string): Record<string, OutValue> {
  const ref = budget.referenceDate(book);
  const out: Record<string, OutValue> = {};
  if (ref === null) return out;
  const year = Number(ref.slice(0, 4));
  const month = Number(ref.slice(5, 7));
  for (let back = 0; back < 3; back++) {
    const [y, m] = budget.shiftMonth(year, month, -back);
    out[budget.monthLabel(y, m)] = spendOut(
      budget.spendingByCategory(book, currency, { year: y, month: m }),
    );
  }
  const quarter = Math.floor((month - 1) / 3) + 1;
  out[`${year}-Q${quarter}`] = spendOut(
    budget.spendingByCategory(book, currency, { year, quarter }),
  );
  out[String(year)] = spendOut(budget.spendingByCategory(book, currency, { year }));
  return out;
}

function profileOut(db: PythonDb, profileId: number, baseCurrency: string | null): OutValue {
  const book = budgetBook(db, profileId, baseCurrency);
  const perCurrency: Record<string, OutValue> = {};
  const currencies = budget.budgetCurrencies(book);
  for (const { currency } of currencies) {
    const all = budget.spendingByCategory(book, currency);
    perCurrency[currency] = {
      cashflow: cashflowOut(budget.monthlyCashflow(book, currency)),
      cashflow_with_internal: cashflowOut(budget.monthlyCashflow(book, currency, true)),
      spending_all: spendOut(all),
      spending_periods: periodsOut(book, currency),
      category_transactions: all.map((row) => ({
        category: row.category,
        rows: drillOut(budget.categoryTransactions(book, row.category, currency)),
      })),
      category_transactions_by_amount: all.slice(0, 3).map((row) => ({
        category: row.category,
        rows: drillOut(
          budget.categoryTransactions(book, row.category, currency, {
            sort: "amount",
            order: "asc",
          }),
        ),
      })),
    };
  }
  const ctx: budget.EngineContext = {
    ownIbans: core.ownIbans(book.accounts),
    rules: budget.rulesByMerchant(
      db.categoryRules(profileId).map((r) => ({ ...r, source: r.source as budget.RuleSource })),
    ),
    patterns: db.loanPaymentPatterns(profileId),
    moduleTextRules: MODULE_TEXT_RULES,
  };
  const recurring = budget.recurringPayments(book, ctx, NOT_SUBSCRIPTION);
  return {
    base_currency: book.baseCurrency,
    currencies: currencies.map((c) => ({
      currency: c.currency,
      transactions: BigInt(c.transactions),
      first: c.first,
      last: c.last,
    })),
    reference_date: budget.referenceDate(book),
    per_currency: perCurrency,
    recurring: recurringOut(recurring),
    active_recurring: recurringOut(budget.activeRecurring(recurring, book)),
    not_subscription_categories: [...NOT_SUBSCRIPTION].sort(budget.codePointCompare),
  };
}

export function produceBudgetAnalytics(db: PythonDb): OutValue {
  const out: Record<string, OutValue> = {};
  for (const p of db.profiles()) {
    out[db.keys.key("profiles", p.id)] = profileOut(db, p.id, p.baseCurrency);
  }
  return out;
}
