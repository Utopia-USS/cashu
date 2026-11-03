/**
 * Producer of `budget.analytics` (`parity/python/checks/budget.py:analytics`): per profile, the base
 * currency, the budget currencies, the reference date; per currency the monthly cashflow (with and
 * without internal moves), spending by category (all time, the last three months, the quarter and
 * the year of the reference date), the drill-down of every category (by date, and the top three by
 * amount); the recurring and active recurring payments and the not-a-subscription categories.
 *
 * Currency/reference metadata, cashflow and spending use the actual S42a screen Query.run closures
 * over the genesis-folded native vault. Remaining drill-down/recurring fields retain the existing
 * domain adapter over copied source facts (`book.ts`). No Python output contributes to native query
 * inputs; the unchanged check schema compares those results with the independent Python oracle.
 */

import { budget, core } from "@cashu/domain";
import {
  budgetScreenCashflow,
  budgetScreenCurrencies,
  budgetScreenSpending,
} from "@cashu/store/budget/queries";
import type { Read } from "@cashu/store/query";
import type { PythonDb } from "../../sources/index.ts";
import type { OutValue } from "../output.ts";
import { genesisRun } from "../store/genesisRun.ts";
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

function periodsOut(
  read: Read,
  today: string,
  currency: string,
  ref: string | null,
): Record<string, OutValue> {
  const out: Record<string, OutValue> = {};
  if (ref === null) return out;
  const year = Number(ref.slice(0, 4));
  const month = Number(ref.slice(5, 7));
  for (let back = 0; back < 3; back++) {
    const [y, m] = budget.shiftMonth(year, month, -back);
    out[budget.monthLabel(y, m)] = spendOut(
      budgetScreenSpending.run(read, {
        today,
        currency,
        period: { year: y, month: m },
        lang: "pl",
      }).rows,
    );
  }
  const quarter = Math.floor((month - 1) / 3) + 1;
  out[`${year}-Q${quarter}`] = spendOut(
    budgetScreenSpending.run(read, {
      today,
      currency,
      period: { year, quarter },
      lang: "pl",
    }).rows,
  );
  out[String(year)] = spendOut(
    budgetScreenSpending.run(read, {
      today,
      currency,
      period: { year },
      lang: "pl",
    }).rows,
  );
  return out;
}

function profileOut(db: PythonDb, profileId: number, baseCurrency: string | null): OutValue {
  const book = budgetBook(db, profileId, baseCurrency);
  const vault = genesisRun(db).vaults.get(profileId);
  if (vault === undefined) throw new Error("native budget query vault is absent");
  const read = vault.store.read.bind(vault.store);
  const today = db.asOf;
  const nativeCurrencies = budgetScreenCurrencies.run(read, { today });
  const perCurrency: Record<string, OutValue> = {};
  const currencies = nativeCurrencies.currencies;
  for (const { currency } of currencies) {
    const all = budget.spendingByCategory(book, currency);
    perCurrency[currency] = {
      cashflow: cashflowOut(
        budgetScreenCashflow.run(read, {
          today,
          currency,
          period: {},
        }).rows,
      ),
      cashflow_with_internal: cashflowOut(budget.monthlyCashflow(book, currency, true)),
      spending_all: spendOut(
        budgetScreenSpending.run(read, {
          today,
          currency,
          period: {},
          lang: "pl",
        }).rows,
      ),
      spending_periods: periodsOut(read, today, currency, nativeCurrencies.referenceDate),
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
    base_currency: nativeCurrencies.baseCurrency,
    currencies: currencies.map((c) => ({
      currency: c.currency,
      transactions: BigInt(c.transactions),
      first: c.first,
      last: c.last,
    })),
    reference_date: nativeCurrencies.referenceDate,
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
