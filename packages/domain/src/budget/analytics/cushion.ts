/**
 * The cushion (emergency fund) side of the month close (`monthclose.py`: `_cushion_accounts`,
 * `_average_spending`, `_destination`, `cushion_level`, `cushion_state`).
 *
 * Level = the cushion accounts' balance as of the day before the month (the newest snapshot then plus
 * the rows booked after it) + the month's transfers on them (in minus out), so the month's own income
 * and spending booked on a cushion account are never counted twice: they are the surplus (F6 review
 * V7). A transfer out to another own account in the cushion's currency that funded the month's spending
 * there is added back up to that spending (F7 review R5). Without an earlier balance the start is the
 * month-end balance minus the month's income and spending on the account.
 */

import { type AccountTypeRegistry, contribution, ZERO_00 } from "../../core/index.js";
import { addDays, daysInMonth, type IsoDate } from "../../dates.js";
import { D, type Decimal, ZERO } from "../../decimal.js";
import { ibanKey } from "../../iban.js";
import {
  type BudgetAccount,
  type BudgetBook,
  type BudgetTxn,
  bookOwnIbans,
  isFlow,
  monthLabel,
} from "./book.js";
import { monthlyCashflow } from "./cashflow.js";
import type { CushionSettings } from "./settings.js";

/** `CUSHION_AVERAGE_MONTHS`: months averaged for a `target_months` cushion (ending with the closed month). */
export const CUSHION_AVERAGE_MONTHS = 6;

const CENT = D("0.01");
const SAVINGS = "savings";

/** Python `max(a, b)`: the first argument unless the second is strictly greater. */
export function pyMax(a: Decimal, b: Decimal): Decimal {
  return b.gt(a) ? b : a;
}

/** Python `min(a, b)`: the first argument unless the second is strictly smaller. */
export function pyMin(a: Decimal, b: Decimal): Decimal {
  return b.lt(a) ? b : a;
}

/** The latest `(as-of date, raw value)` per account as of a date (`core.latestBalancePerAccount`). */
export type LatestBalances = (asOf: IsoDate) => ReadonlyMap<string, readonly [IsoDate, Decimal]>;

/** What the cushion reads besides the book: balances and the account type registry. */
export interface CushionEnv {
  readonly latestAt: LatestBalances;
  readonly types: AccountTypeRegistry;
}

export interface CushionState {
  readonly currency: string;
  /** Null when a months target has no spending history to average. */
  readonly target: Decimal | null;
  readonly targetSource: "amount" | "months";
  readonly targetMonths: number | null;
  readonly balance: Decimal;
  readonly missing: Decimal;
  readonly topUp: Decimal;
  readonly accounts: readonly BudgetAccount[];
  readonly averageSpending: Decimal | null;
}

/**
 * `_cushion_accounts`: the chosen accounts in the currency, else the active savings accounts in it; in
 * storage order. Removed accounts are not filtered (Python does not either; they have no balance).
 */
export function cushionAccounts(
  book: BudgetBook,
  cushion: CushionSettings,
  currency: string,
): BudgetAccount[] {
  const chosen = new Set(cushion.accountIds);
  return book.accounts.filter(
    (a) =>
      a.currency === currency &&
      (chosen.size > 0 ? chosen.has(a.id) : a.type === SAVINGS && a.active),
  );
}

/** `_average_spending`: mean monthly expense of up to 6 months ending with the closed one, to 0.01. */
export function averageSpending(
  book: BudgetBook,
  currency: string,
  year: number,
  month: number,
): Decimal | null {
  const label = monthLabel(year, month);
  const rows = monthlyCashflow(book, currency)
    .filter((r) => r.label <= label)
    .slice(-CUSHION_AVERAGE_MONTHS);
  if (rows.length === 0) return null;
  let total = ZERO_00;
  for (const r of rows) total = total.add(r.expense);
  return total.div(D(String(rows.length))).quantize(CENT);
}

function monthEndOf(year: number, month: number): IsoDate {
  return `${monthLabel(year, month)}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

/**
 * Each account's rows in its own currency: a row in another currency (a foreign or malformed event)
 * never moves a balance in this one (data-safety rule 5).
 */
function rowsByAccount(book: BudgetBook): Map<string, BudgetTxn[]> {
  const currencyOf = new Map(book.accounts.map((a) => [a.id, a.currency]));
  const out = new Map<string, BudgetTxn[]>();
  for (const t of book.transactions) {
    if (t.currency !== currencyOf.get(t.account)) continue;
    const list = out.get(t.account);
    if (list === undefined) out.set(t.account, [t]);
    else list.push(t);
  }
  return out;
}

function sumAmounts(rows: readonly BudgetTxn[]): Decimal {
  let total = ZERO_00;
  for (const t of rows) total = total.add(t.amount);
  return total;
}

/**
 * `_destination`: the own account that received an outgoing transfer: the other leg of its matched
 * pair, the cash pool for a withdrawal mirrored into it, or the own account named by the counterparty
 * account number; null for money that left the profile. A pair has one other leg (Python takes the
 * first by id; transfer groups are pairs).
 */
function destination(
  t: BudgetTxn,
  book: BudgetBook,
  legAccount: ReadonlyMap<string, string>,
  byIban: ReadonlyMap<string, string>,
): string | null {
  if (t.transferGroup) {
    const other = book.transactions.find(
      (o) => o.transferGroup === t.transferGroup && o.account !== t.account,
    );
    if (other !== undefined) return other.account;
  }
  const leg = legAccount.get(t.key);
  if (leg !== undefined) return leg;
  if (t.counterpartyIban) return byIban.get(ibanKey(t.counterpartyIban)) ?? null;
  return null;
}

/** `cushion_level`: the cushion accounts' level for the close of `year-month` (see the file doc). */
export function cushionLevel(
  book: BudgetBook,
  accounts: readonly BudgetAccount[],
  year: number,
  month: number,
  env: CushionEnv,
): Decimal {
  if (accounts.length === 0) return ZERO_00;
  const monthStart = `${monthLabel(year, month)}-01`;
  const before = addDays(monthStart, -1);
  const monthEnd = monthEndOf(year, month);
  const own = bookOwnIbans(book);
  const atStart = env.latestAt(before);
  const atEnd = env.latestAt(monthEnd);
  const cushionIds = new Set(accounts.map((a) => a.id));
  const cushionCurrencies = new Set(accounts.map((a) => a.currency));
  const byIban = new Map<string, string>();
  for (const a of book.accounts) if (a.iban) byIban.set(ibanKey(a.iban), a.id);
  const currencyOf = new Map(book.accounts.map((a) => [a.id, a.currency]));
  const legAccount = new Map<string, string>();
  for (const t of book.transactions) {
    if (t.cashLegOf !== null && !legAccount.has(t.cashLegOf))
      legAccount.set(t.cashLegOf, t.account);
  }
  const byAccount = rowsByAccount(book);
  const sent = new Map<string, Decimal>();
  let level = ZERO_00;
  for (const acc of accounts) {
    const rows = (byAccount.get(acc.id) ?? []).filter((t) => t.bookingDate <= monthEnd);
    const inMonth = rows.filter((t) => t.bookingDate >= monthStart);
    const moves = inMonth.filter((t) => !isFlow(t, own));
    const start = atStart.get(acc.id);
    let amount: Decimal;
    if (start !== undefined) {
      const [snapshotDay, snapshot] = start;
      const after = rows.filter((t) => snapshotDay < t.bookingDate && t.bookingDate <= before);
      amount = snapshot.add(sumAmounts(after)).add(sumAmounts(moves));
    } else {
      const end = atEnd.get(acc.id);
      if (end === undefined) continue;
      amount = end[1].sub(sumAmounts(inMonth.filter((t) => isFlow(t, own))));
    }
    level = level.add(contribution(env.types, acc, amount) ?? ZERO_00);
    for (const t of moves) {
      if (t.amount.gte(ZERO)) continue;
      const dest = destination(t, book, legAccount, byIban);
      const destCurrency = dest === null ? undefined : currencyOf.get(dest);
      if (
        dest !== null &&
        !cushionIds.has(dest) &&
        destCurrency !== undefined &&
        cushionCurrencies.has(destCurrency)
      ) {
        sent.set(dest, (sent.get(dest) ?? ZERO_00).sub(t.amount));
      }
    }
  }
  for (const [dest, amount] of sent) {
    let spent = ZERO_00;
    for (const t of byAccount.get(dest) ?? []) {
      if (t.bookingDate < monthStart || t.bookingDate > monthEnd) continue;
      if (t.amount.lt(ZERO) && isFlow(t, own)) spent = spent.sub(t.amount);
    }
    level = level.add(pyMin(amount, spent));
  }
  return level;
}

/** `cushion_state`: target, level, what is missing and this month's top-up (from `surplus`). */
export function cushionState(
  book: BudgetBook,
  cushion: CushionSettings,
  year: number,
  month: number,
  surplus: Decimal,
  env: CushionEnv,
): CushionState {
  const currency = cushion.currency || book.baseCurrency;
  const accounts = cushionAccounts(book, cushion, currency);
  const balance = cushionLevel(book, accounts, year, month, env);
  let average: Decimal | null = null;
  let target: Decimal | null;
  let source: "amount" | "months";
  if (cushion.targetAmount !== null) {
    target = cushion.targetAmount;
    source = "amount";
  } else {
    average = averageSpending(book, currency, year, month);
    const months = cushion.targetMonths ?? 0;
    target = average === null ? null : average.mul(D(String(months))).quantize(CENT);
    source = "months";
  }
  const missing = target === null ? ZERO_00 : pyMax(ZERO_00, target.sub(balance));
  let topUp = pyMin(missing, pyMax(ZERO_00, surplus));
  if (cushion.monthlyMax !== null) topUp = pyMin(topUp, cushion.monthlyMax);
  return {
    currency,
    target,
    targetSource: source,
    targetMonths: source === "months" ? cushion.targetMonths : null,
    balance,
    missing,
    topUp,
    accounts,
    averageSpending: average,
  };
}
