// The banana scale of the desktop privacy mode (`@cashu/domain` core/bananas.ts) for one vault: the
// average monthly salary of the budget's whole months, else a tenth of the brokerage accounts' value,
// both in PLN at today's NBP rates, plus the PLN rate of every account currency so the renderer can
// convert any amount. Only the factor and the rates leave the host, never the anchor itself.
import { budget, core, D, type Decimal, type IsoDate, ZERO } from "@cashu/domain";
import { budgetBook } from "../budget/read-models.js";
import { profileOf } from "../core/queries.js";
import type { Read } from "../query.js";
import type { NetWorthEnv } from "../registry.js";
import { type OverviewSources, vaultNetWorthBook, vaultRateAt } from "./networth.js";

/** The scale, or null when the vault has neither a salary nor an invested portfolio. */
export function bananaScaleView(
  read: Read,
  env: NetWorthEnv,
  sources: OverviewSources = {},
): core.BananaScale | null {
  const rateAt = vaultRateAt(read, env, sources, "PLN");
  const currencies = read<{ currency: string }>(
    "SELECT DISTINCT currency FROM accounts WHERE removed_at IS NULL ORDER BY currency",
  ).map((r) => r.currency);
  const plnRates: Record<string, number> = {};
  for (const c of currencies) {
    if (c === "PLN") continue;
    const q = rateAt(c, env.today);
    if (q !== null) plnRates[c] = q.rate.toFloat();
  }
  const toPln = (amount: Decimal, currency: string): Decimal | null => {
    if (currency === "PLN") return amount;
    const q = rateAt(currency, env.today);
    return q === null ? null : amount.mul(q.rate);
  };

  const salary = core.salaryAnchor(salaryMonths(read, env.today, toPln), env.today);
  if (salary !== null) return core.bananaScale("salary", salary, plnRates);

  let invested = ZERO;
  const book = vaultNetWorthBook(read, env, sources);
  const summary = core.netWorthSummary(book, profileOf(read)?.baseCurrency);
  for (const line of summary.lines) {
    if (line.account.type !== core.BROKERAGE || line.contribution === null) continue;
    const pln = toPln(line.contribution, line.account.currency);
    if (pln !== null) invested = invested.add(pln);
  }
  return core.bananaScale("portfolio", core.portfolioAnchor(invested), plnRates);
}

/**
 * The salary (`income_salary` flows, in PLN) of every whole month the salary accounts cover, before
 * today's month. The window is the accounts that receive the salary, from their first whole month to
 * their newest row, so a bank account added later does not shorten it, a first import month that starts
 * after the payday does not drag the average down, and months after the last import are not months
 * without pay (the newest month counts only with its salary in). A row without a real category yet
 * (none, or the categorizer's `default` fallback) counts when its text (title, description,
 * counterparty) carries the categorizer's salary keywords, so the scale does not wait for the
 * categorization pass; a category the owner or a rule set always wins.
 */
function salaryMonths(
  read: Read,
  today: IsoDate,
  toPln: (amount: Decimal, currency: string) => Decimal | null,
): core.SalaryMonth[] {
  const book = budgetBook(read);
  const own = core.ownIbans(book.accounts);
  const totals = new Map<string, Decimal>();
  const payees = new Set<string>();
  for (const t of book.transactions) {
    // `default`: the categorizer's fallback for an inflow it could not place, not a decision.
    const undecided = t.category === null || t.categorySource === "default";
    const salary =
      t.category === "income_salary" ||
      (undecided && t.amount.gt(ZERO) && budget.isSalaryKey(budget.txnText(t)));
    if (!salary || !t.amount.gt(ZERO) || !budget.isFlow(t, own)) continue;
    const pln = toPln(t.amount, t.currency);
    if (pln === null) continue;
    payees.add(t.account);
    const month = t.bookingDate.slice(0, 7);
    totals.set(month, (totals.get(month) ?? ZERO).add(pln));
  }
  let first: string | null = null;
  let last: string | null = null;
  for (const t of book.transactions) {
    if (!payees.has(t.account)) continue;
    if (first === null || t.bookingDate < first) first = t.bookingDate;
    if (last === null || t.bookingDate > last) last = t.bookingDate;
  }
  if (first === null || last === null) return [];
  const next = (month: string) => {
    const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
    return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  };
  const end = last.slice(0, 7) < today.slice(0, 7) ? last.slice(0, 7) : null;
  const months: core.SalaryMonth[] = [];
  let month = first.slice(8, 10) === "01" ? first.slice(0, 7) : next(first.slice(0, 7));
  for (; month < today.slice(0, 7) && (end === null || month <= end); month = next(month))
    months.push({ month, salary: totals.get(month) ?? D("0"), hasData: true });
  if (months.at(-1)?.salary.isZero() && months.at(-1)?.month === end) months.pop();
  return months;
}
