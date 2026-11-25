/**
 * Spending by category and the drill-down into one category (`modules/budget/analytics.py`). One
 * currency at a time; transfers, structural moves and own-account counterparties are never spending.
 */

import type { UiLang } from "../../core/index.js";
import { ZERO_00 } from "../../core/index.js";
import type { IsoDate } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { categoryLabel } from "../categorize/index.js";
import { merchantKey } from "../ingestion/index.js";
import {
  type BudgetBook,
  type BudgetTxn,
  bookOwnIbans,
  inPeriod,
  isOwnCounterparty,
  NON_SPENDING_CATEGORIES,
  type Period,
} from "./book.js";

export interface CategorySpend {
  readonly category: string;
  /** `taxonomy.label` in the UI language. */
  readonly label: string;
  /** Positive expense magnitude. */
  readonly amount: Decimal;
}

/**
 * `spending_by_category`: expense totals per category (uncategorized = `other`) in one currency (the
 * base currency when none is given), optionally for a year, month or quarter; largest first, equal
 * totals in first-seen order (Python's stable sort).
 */
export function spendingByCategory(
  book: BudgetBook,
  currency: string | null = null,
  period: Period = {},
  lang: UiLang = "pl",
): CategorySpend[] {
  const cur = currency || book.baseCurrency;
  const own = bookOwnIbans(book);
  const buckets = new Map<string, Decimal>();
  for (const t of book.transactions) {
    if (t.currency !== cur) continue;
    if (t.amount.gte(ZERO) || t.isInternalTransfer) continue;
    if (t.category !== null && NON_SPENDING_CATEGORIES.has(t.category)) continue;
    if (isOwnCounterparty(t, own) || !inPeriod(t.bookingDate, period)) continue;
    const cat = t.category || "other";
    buckets.set(cat, (buckets.get(cat) ?? ZERO_00).add(t.amount.neg()));
  }
  const out = [...buckets].map(([category, amount]) => ({
    category,
    label: categoryLabel(category, lang),
    amount,
  }));
  return out.sort((a, b) => b.amount.compare(a.amount));
}

/** Python `str[-4:]` (code points). */
function lastFour(s: string): string {
  return Array.from(s).slice(-4).join("");
}

/**
 * `_txn_details`: a secondary "so you can tell what it is" line: recipient, memo, the account number's
 * last four characters and the bank id, skipping what already is the primary title; null when empty.
 */
export function txnDetails(t: BudgetTxn, primary: string | null): string | null {
  const parts: string[] = [];
  if (t.counterpartyName && t.counterpartyName !== primary) parts.push(t.counterpartyName);
  if (t.description && t.description !== primary && t.description !== t.counterpartyName) {
    parts.push(t.description);
  }
  if (t.counterpartyIban) parts.push(`…${lastFour(t.counterpartyIban)}`);
  if (t.bankTransactionId) parts.push(`nr ${t.bankTransactionId}`);
  return [...new Set(parts)].join(" · ") || null;
}

/** One drill-down row (`category_transactions`), the API's dict. */
export interface CategoryTxnRow {
  readonly key: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly currency: string;
  readonly merchant: string;
  readonly merchantKey: string;
  readonly details: string | null;
  readonly counterparty: string | null;
  /** As stored (null for an uncategorized row listed under `other`). */
  readonly category: string | null;
  readonly categorySource: string | null;
  /** The account's name, null when the account is not the profile's. */
  readonly account: string | null;
}

export interface CategoryTxnOptions extends Period {
  /** `date` (default) or `amount` (by magnitude). */
  readonly sort?: "date" | "amount";
  /** `desc` (default); anything but `asc` is descending, as in Python. */
  readonly order?: string;
}

/**
 * `category_transactions`: the rows of one category (uncategorized rows are `other`) in one currency,
 * optionally for a period, sorted by date or by amount magnitude (stable: ties keep storage order).
 */
export function categoryTransactions(
  book: BudgetBook,
  category: string,
  currency: string | null = null,
  opts: CategoryTxnOptions = {},
): CategoryTxnRow[] {
  const cur = currency || book.baseCurrency;
  const names = new Map(book.accounts.map((a) => [a.id, a.name]));
  const rows: CategoryTxnRow[] = [];
  for (const t of book.transactions) {
    if (t.currency !== cur || (t.category || "other") !== category) continue;
    if (!inPeriod(t.bookingDate, opts)) continue;
    const key = merchantKey(t.counterpartyName, t.reference, t.description);
    const merchant = t.reference || t.description || t.counterpartyName || key;
    rows.push({
      key: t.key,
      date: t.bookingDate,
      amount: t.amount,
      currency: t.currency,
      merchant,
      merchantKey: key,
      details: txnDetails(t, merchant),
      counterparty: t.counterpartyName,
      category: t.category,
      categorySource: t.categorySource,
      account: names.get(t.account) ?? null,
    });
  }
  const sign = opts.order === "asc" ? 1 : -1;
  if (opts.sort === "amount") {
    return rows.sort((a, b) => sign * a.amount.copyAbs().compare(b.amount.copyAbs()));
  }
  return rows.sort((a, b) => sign * (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
