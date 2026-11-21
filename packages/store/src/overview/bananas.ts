// The banana scale of the desktop privacy mode (`@cashu/domain` core/bananas.ts) for one vault: the
// average monthly salary of the budget's whole months, else a tenth of the brokerage accounts' value,
// both in PLN at today's NBP rates, plus the PLN rate of every account currency so the renderer can
// convert any amount. Only the factor and the rates leave the host, never the anchor itself.
//
// `@cashu/store/overview/bananas` is its own entry (like `./networth.ts`) so the phone, whose bundler
// (Metro) does not tree-shake, carries the scale without the desktop widgets of `./index.ts`.
import { budget, core, D, type Decimal, type IsoDate, ZERO } from "@cashu/domain";
import type { market } from "@cashu/domain/investments";
import { budgetBook } from "../budget/read-models.js";
import { profileOf } from "../core/queries.js";
import { type ChangeSource, defineQuery, type Query, type Read } from "../query.js";
import type { NetWorthEnv } from "../registry.js";
import { type OverviewSources, vaultNetWorthBook, vaultRateAt } from "./networth.js";

/**
 * The privacy mode's banana scale query (`core.bananaScale`) over the device's price cache (null: last
 * trade prices); null without a salary or a portfolio. The overview queries reuse this factory, so the
 * id has one definition.
 */
export function bananaScaleQuery(
  env: { readonly prices: market.PriceCache | null; readonly changes?: ChangeSource },
  sources: OverviewSources = {},
): Query<{ readonly today: IsoDate }, core.BananaScale | null> {
  const prices = env.prices;
  return defineQuery({
    id: "core.bananaScale",
    ...(env.changes === undefined ? {} : { changes: env.changes }),
    run: (read, args: { readonly today: IsoDate }) =>
      bananaScaleView(read, { today: args.today, prices }, sources),
  });
}

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

  const salary = core.salaryAnchor(
    salaryMonths(read, env.today, toPln, sources.companionReads === true),
    env.today,
  );
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
  companionReads: boolean,
): core.SalaryMonth[] {
  const book = companionReads ? salaryBook(read) : budgetBook(read);
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
  if (companionReads) [first, last] = bookingSpan(read, [...payees]);
  else {
    for (const t of book.transactions) {
      if (!payees.has(t.account)) continue;
      if (first === null || t.bookingDate < first) first = t.bookingDate;
      if (last === null || t.bookingDate > last) last = t.bookingDate;
    }
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

/**
 * The part of `budgetBook` the salary reads on a companion store: every account, and of the visible
 * accounts' rows only those that may count as salary (an inflow categorized `income_salary`, or an
 * undecided one: no category or the `default` fallback); the loop above applies the same tests.
 */
function salaryBook(read: Read): {
  readonly accounts: readonly { readonly iban: string | null }[];
  readonly transactions: readonly budget.BudgetTxn[];
} {
  const accounts = read<{ iban: string | null }>("SELECT iban FROM accounts");
  const rows = read<{
    account: string;
    bookingDate: IsoDate;
    amount: string;
    currency: string;
    counterpartyName: string | null;
    counterpartyIban: string | null;
    description: string | null;
    reference: string | null;
    category: string | null;
    categorySource: string | null;
    internal: number;
  }>(
    `SELECT a.gid AS account, t.booking_date AS bookingDate, t.amount, t.currency,
       t.counterparty_name AS counterpartyName, t.counterparty_iban AS counterpartyIban,
       t.description, t.reference, t.category, t.category_source AS categorySource,
       t.is_internal_transfer AS internal
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE a.removed_at IS NULL AND t.amount NOT LIKE '-%'
       AND (t.category = 'income_salary' OR t.category IS NULL OR t.category_source = 'default')`,
  );
  return {
    accounts,
    transactions: rows.map((t) => ({
      key: "",
      account: t.account,
      bookingDate: t.bookingDate,
      amount: D(t.amount),
      currency: t.currency,
      counterpartyName: t.counterpartyName,
      counterpartyIban: t.counterpartyIban,
      description: t.description,
      reference: t.reference,
      bankTransactionId: null,
      category: t.category,
      categorySource: t.categorySource,
      isInternalTransfer: t.internal === 1,
      transferGroup: null,
      cashLegOf: null,
    })),
  };
}

/** The first and last booking day of `accounts` (account gids) from the day groups (`budget.months`). */
function bookingSpan(read: Read, accounts: readonly string[]): [IsoDate | null, IsoDate | null] {
  if (accounts.length === 0) return [null, null];
  const day = "d.month || '-' || substr('0' || d.day, -2)";
  const span = read<{ first: IsoDate | null; last: IsoDate | null }>(
    `SELECT min(${day}) AS first, max(${day}) AS last
     FROM fold_month_day d JOIN accounts a ON a.id = d.account_id
     WHERE d.n > 0 AND a.gid IN (${accounts.map(() => "?").join(", ")})`,
    ...accounts,
  )[0];
  return [span?.first ?? null, span?.last ?? null];
}
