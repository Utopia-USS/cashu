// Budget MCP reads preserve Python's per-currency filters, stable ordering and denominators.
import {
  budget,
  core,
  D,
  type Decimal,
  pyStrip,
  pyUpper,
  unicodeDecimal,
  ZERO,
} from "@cashu/domain";
import { budgetBook, budgetEngineContext } from "@cashu/store/budget/queries";
import { vaultPaymentPatterns } from "@cashu/store/overview";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

type Context = ToolContext<NativeToolStore>;
const PERIOD = /^(\p{Nd}{4})(?:-(?:(\p{Nd}{2})|Q([1-4])))?$/u;
const integer = (text: string): number =>
  Array.from(text).reduce((value, ch) => value * 10 + unicodeDecimal(ch.codePointAt(0) ?? 0), 0);
function currency(ctx: Context, value: unknown): string {
  const cur = pyUpper(
    pyStrip((typeof value === "string" && value) || ctx.store.profile.baseCurrency || "PLN"),
  );
  if (!/^[A-Z]{3}$/.test(cur)) throw new ToolError("currency must be a 3-letter code");
  return cur;
}
function period(
  book: budget.BudgetBook,
  value: unknown,
): { label: string | null; filter: budget.Period } {
  if (typeof value !== "string" || !value) {
    const ref = budget.referenceDate(book);
    return ref === null
      ? { label: null, filter: {} }
      : {
          label: ref.slice(0, 7),
          filter: { year: Number(ref.slice(0, 4)), month: Number(ref.slice(5, 7)) },
        };
  }
  const label = pyStrip(value);
  const match = PERIOD.exec(label);
  if (!match?.[1]) throw new ToolError("period must look like 2026, 2026-09 or 2026-Q3");
  const month = match[2] === undefined ? null : integer(match[2]);
  if (month !== null && (month < 1 || month > 12)) throw new ToolError("month must be 01-12");
  return {
    label,
    filter: {
      year: integer(match[1]),
      month,
      quarter: match[3] === undefined ? null : integer(match[3]),
    },
  };
}
export function spendingBreakdown(ctx: Context, args: ToolArgs): L.LabelledTree {
  const cur = currency(ctx, args.currency);
  const book = budgetBook(ctx.store.read);
  const { label, filter } = period(book, args.period);
  const categories = label === null ? [] : budget.spendingByCategory(book, cur, filter, "pl");
  // Preserve Python's row-by-row Decimal accumulation order, independently of category grouping.
  let total = ZERO;
  const merchants = new Map<string, { amount: Decimal; count: number }>();
  const own = core.ownIbans(book.accounts);
  if (label !== null)
    for (const t of book.transactions) {
      if (
        t.currency !== cur ||
        t.amount.gte(ZERO) ||
        !budget.isFlow(t, own) ||
        !budget.inPeriod(t.bookingDate, filter)
      )
        continue;
      total = total.sub(t.amount);
      const key = budget.merchantKey(t.counterpartyName, t.reference, t.description);
      if (!key) continue;
      const previous = merchants.get(key);
      merchants.set(key, {
        amount: (previous?.amount ?? ZERO).sub(t.amount),
        count: (previous?.count ?? 0) + 1,
      });
    }
  return {
    currency: L.category(cur),
    period: L.date(label),
    base_note: L.fixedText("shares are of the period's total spending in this currency"),
    total: L.amount(total),
    categories: categories.map((row) => ({
      category: L.category(row.category),
      label: L.text(row.label),
      share: L.share(row.amount, total),
      amount: L.amount(row.amount),
    })),
    top_merchants: [...merchants]
      .sort((a, b) => b[1].amount.compare(a[1].amount))
      .slice(0, typeof args.top === "number" ? args.top : 10)
      .map(([key, row]) => ({
        merchant: L.merchant(key),
        share: L.share(row.amount, total),
        count: L.count(row.count),
        amount: L.amount(row.amount),
      })),
  };
}
export function cashflowSummary(ctx: Context, args: ToolArgs): L.LabelledTree {
  const cur = currency(ctx, args.currency);
  const rows = budget
    .monthlyCashflow(budgetBook(ctx.store.read), cur)
    .slice(-(typeof args.months === "number" ? args.months : 12));
  const income = rows.reduce((sum, row) => sum.add(row.income), ZERO);
  const expense = rows.reduce((sum, row) => sum.add(row.expense), ZERO);
  return {
    currency: L.category(cur),
    months: L.count(rows.length),
    savings_rate: L.share(income.sub(expense), income),
    income_expense_ratio: L.pct(expense.isZero() ? null : income.div(expense)),
    deficit_months: rows.filter((row) => row.net.lt(ZERO)).map((row) => L.text(row.label)),
    income: L.amount(income),
    expense: L.amount(expense),
    monthly: rows.map((row) => ({
      month: L.text(row.label),
      savings_rate: L.share(row.net, row.income),
      expense_vs_average: L.share(row.expense, expense.div(D(BigInt(rows.length)))),
      deficit: L.flag(row.net.lt(ZERO)),
      income: L.amount(row.income),
      expense: L.amount(row.expense),
      net: L.amount(row.net),
    })),
  };
}
export function recurringPayments(ctx: Context): L.LabelledTree {
  const book = budgetBook(ctx.store.read);
  const registry = core.builtinRegistry();
  const engine = budgetEngineContext(
    ctx.store.read,
    vaultPaymentPatterns(ctx.store.read),
    registry,
  );
  const rows = budget.recurringPayments(book, engine, budget.subscriptionExclusions(registry));
  // activeRecurring filters this same list, so identity is preserved without serializing amounts.
  const active = new Set(budget.activeRecurring(rows, book));
  const averages = new Map<string, Decimal | null>();
  return {
    base_note: L.fixedText(
      "share_of_monthly_spending: one payment vs the average monthly spending of the last 3 months in that currency",
    ),
    items: rows.map((row) => {
      if (!averages.has(row.currency)) {
        const months = budget.monthlyCashflow(book, row.currency).slice(-3);
        averages.set(
          row.currency,
          months.length === 0
            ? null
            : months
                .reduce((sum, month) => sum.add(month.expense), ZERO)
                .div(D(BigInt(months.length))),
        );
      }
      return {
        merchant: L.merchant(row.counterparty),
        currency: L.category(row.currency),
        cadence_days: L.count(row.medianGapDays),
        occurrences: L.count(row.occurrences),
        months_covered: L.count(row.monthsCovered),
        last: L.date(row.lastDate),
        active: L.flag(active.has(row)),
        share_of_monthly_spending: L.share(row.typicalAmount, averages.get(row.currency) ?? null),
        typical_amount: L.amount(row.typicalAmount),
      };
    }),
  };
}
export function uncategorizedMerchants(ctx: Context, args: ToolArgs): L.LabelledTree {
  const totals = new Map<string, Decimal>();
  const rows = new Map<
    string,
    { merchant: string; currency: string; count: number; total: Decimal }
  >();
  for (const t of budgetBook(ctx.store.read).transactions) {
    if (t.amount.gte(ZERO) || t.isInternalTransfer || t.categorySource !== "default") continue;
    const merchant = budget.merchantKey(t.counterpartyName, t.reference, t.description);
    if (!merchant) continue;
    const key = JSON.stringify([merchant, t.currency]);
    const previous = rows.get(key);
    rows.set(key, {
      merchant,
      currency: t.currency,
      count: (previous?.count ?? 0) + 1,
      total: (previous?.total ?? ZERO).sub(t.amount),
    });
    totals.set(t.currency, (totals.get(t.currency) ?? ZERO).sub(t.amount));
  }
  return {
    base_note: L.fixedText("share: of all uncategorized spending in that currency"),
    merchants: [...rows.values()]
      .sort((a, b) => b.count - a.count || b.total.compare(a.total))
      .slice(0, typeof args.limit === "number" ? args.limit : 30)
      .map((row) => ({
        merchant: L.merchant(row.merchant),
        currency: L.category(row.currency),
        count: L.count(row.count),
        share: L.share(row.total, totals.get(row.currency) ?? null),
        total: L.amount(row.total),
      })),
    categories: budget.CATEGORY_KEYS.map(L.category),
  };
}
