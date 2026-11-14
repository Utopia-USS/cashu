// The book-based month figures and account balances the phone read before the month aggregates
// (M3): `companionMonth` over the whole `budgetBook` and `accountBalances` over `budgetNetWorth`, kept
// verbatim as the oracle the aggregate-based queries must equal (property and fixture tests). Tests
// only. Synthetic data only.
import { budget, D, type Decimal, type IsoDate, ZERO } from "@cashu/domain";
import {
  type CompanionLargest,
  type CompanionMonth,
  type CompanionMonthArgs,
  companionMonthOf,
} from "../budget/companion-queries.js";
import { budgetBook, budgetNetWorth } from "../budget/read-models.js";
import type { Read } from "../query.js";

const PAYEE_DESCRIPTION_CHARS = 40;
const BALANCE_TYPES = ["checking", "savings", budget.CASH_ACCOUNT_TYPE] as const;

function payeeOf(
  name: string | null,
  reference: string | null,
  description: string | null,
  cash: boolean,
): string {
  if (name) return name;
  if (cash && reference) return reference;
  if (description) return Array.from(description).slice(0, PAYEE_DESCRIPTION_CHARS).join("");
  return reference ?? "";
}

/** The pre-M3 `companionMonth` (every row of the book). */
export function companionMonthFromBook(
  read: Read,
  args: CompanionMonthArgs,
  extra: { readonly book?: budget.BudgetBook; readonly billsDue?: Decimal } = {},
): CompanionMonth {
  const book = extra.book ?? budgetBook(read);
  const currency = args.currency || book.baseCurrency;
  const { label, year, month, ref } = companionMonthOf(args);
  const rows = budget.monthlyCashflow(book, currency);
  const row = rows.find((r) => r.label === label);
  const income = row?.income ?? D("0.00");
  const spent = row?.expense ?? D("0.00");
  const norm = budget.closedMonthNorm(
    rows,
    ref,
    budget.NORM_MONTHS,
    budget.cashflowCoverageStart(book, currency),
  );
  const normToDate = budget.usualToDate(book, currency, ref);
  const usualPayDay = budget.usualPayDay(book, currency, ref);
  // The salary input from the raw rows: the book twin of the usual salary, and the largest flow
  // income of the month through `ref` counted here over every row (not over the day groups).
  const usualSalary = budget.usualSalary(book, currency, ref);
  const ownForSalary = budget.bookOwnIbans(book);
  let largestSoFar = D("0");
  for (const t of book.transactions) {
    if (t.currency !== currency || t.bookingDate.slice(0, 7) !== label || t.bookingDate > ref) {
      continue;
    }
    if (t.amount.gt(largestSoFar) && budget.isFlow(t, ownForSalary)) largestSoFar = t.amount;
  }
  const billsDue = extra.billsDue ?? D("0.00");
  const projection = budget.monthProjection({
    today: ref,
    currency,
    incomeSoFar: income,
    spentSoFar: spent,
    billsDue,
    norm,
    normToDate,
    usualPayDay,
    salary: usualSalary === null ? null : { usual: usualSalary, largestSoFar },
  });
  const usual = budget.categoryNorm(book, currency, ref);
  const categories = budget
    .spendingByCategory(book, currency, { year, month }, args.lang)
    .map((c) => ({
      category: c.category,
      label: c.label,
      amount: c.amount,
      usual: usual.get(c.category) ?? null,
      share: spent.isZero() ? 0 : c.amount.div(spent).toFloat(),
    }));
  const cashAccounts = new Set(
    book.accounts.filter((a) => a.type === budget.CASH_ACCOUNT_TYPE).map((a) => a.id),
  );
  const own = budget.bookOwnIbans(book);
  let count = 0;
  let sum = D("0.00");
  let largest: CompanionLargest | null = null;
  // One pass over the month's flow outflows (`isFlow`: the rows `spent` counts): this currency's
  // uncategorized ones, and every other currency's spending.
  const otherSpent = new Map<string, Decimal>();
  for (const t of book.transactions) {
    if (t.bookingDate.slice(0, 7) !== label || !t.amount.lt(ZERO) || !budget.isFlow(t, own))
      continue;
    if (t.currency !== currency) {
      otherSpent.set(t.currency, (otherSpent.get(t.currency) ?? D("0.00")).add(t.amount.neg()));
      continue;
    }
    if (t.categorySource !== "default") continue;
    count += 1;
    sum = sum.add(t.amount.neg());
    if (largest === null || t.amount.lt(largest.amount)) {
      const cash = cashAccounts.has(t.account);
      largest = {
        gid: t.key,
        payee: payeeOf(t.counterpartyName, t.reference, t.description, cash),
        date: t.bookingDate,
        amount: t.amount,
      };
    }
  }
  const otherCurrencies = budget.budgetCurrencies(book).flatMap((c) => {
    const other = otherSpent.get(c.currency);
    return other === undefined || other.isZero() ? [] : [{ currency: c.currency, spent: other }];
  });
  return {
    month: label,
    currency,
    complete: projection.monthEnd < args.today,
    monthEnd: projection.monthEnd,
    daysLeft: projection.daysLeft,
    income,
    spent,
    billsDue,
    norm,
    normToDate,
    usualPayDay,
    projection,
    uncategorized: { count, sum, largest },
    categories,
    otherCurrencies,
  };
}

/** The pre-M3 `accountBalances` (every row through `budgetNetWorth`). */
export function accountBalancesFromBook(read: Read, today: IsoDate): budget.AccountBalance[] {
  const accounts = read<{
    gid: string;
    name: string;
    type: string;
    currency: string;
    active: number;
  }>(
    `SELECT gid, name, type, currency, active FROM accounts
     WHERE removed_at IS NULL AND type IN (?, ?, ?) ORDER BY id`,
    ...BALANCE_TYPES,
  );
  const valuations = budgetNetWorth(read, { today, prices: null }).valuations(
    new Map(
      accounts.map((a) => [
        a.gid,
        { id: a.gid, type: a.type, currency: a.currency, active: a.active === 1, removedAt: null },
      ]),
    ),
  );
  return accounts.flatMap((a) => {
    const latest = valuations.get(a.gid)?.latest(null, today);
    return latest == null
      ? []
      : [{ id: a.gid, name: a.name, currency: a.currency, balance: latest[1] }];
  });
}
