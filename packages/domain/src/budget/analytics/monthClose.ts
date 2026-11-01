/**
 * Month close (`modules/budget/monthclose.py`): what one calendar month earned, spent and left over,
 * per currency, and how much of the surplus to move to investments.
 *
 * - income = inflows of the month, spending = outflows by category, with the cashflow filters
 *   (`isFlow`); each currency on its own, never summed or converted;
 * - surplus = income - spending;
 * - cushion top-up (only in the cushion currency, only when the profile turned the rule on):
 *   `min(target - cushion level, surplus, monthly_max)`, never below 0 (`cushion.ts`);
 * - suggested transfer = surplus - cushion top-up, never below 0;
 * - planned contribution: the investments strategy's monthly amount, read only when the investments
 *   module is enabled for the profile (`investingLink.ts`).
 */

import { ZERO_00 } from "../../core/index.js";
import { daysInMonth, type IsoDate } from "../../dates.js";
import { type Decimal, ZERO } from "../../decimal.js";
import { pyLen, pyStrip, unicodeDecimal } from "../../text.js";
import { codePointCompare } from "../categorize/index.js";
import { type BudgetBook, bookOwnIbans, isFlow, monthLabel, yearMonth } from "./book.js";
import { budgetCurrencies, monthBounds, referenceDate } from "./cashflow.js";
import { type CushionEnv, type CushionState, cushionState, pyMax } from "./cushion.js";
import type { PlannedContribution } from "./investingLink.js";
import type { BudgetSettings } from "./settings.js";

export interface CurrencyClose {
  readonly currency: string;
  readonly income: Decimal;
  readonly spending: Decimal;
  /** Category -> income, first-seen order (uncategorized = `income_other`). */
  readonly incomeByCategory: ReadonlyMap<string, Decimal>;
  /** Category -> spending magnitude, first-seen order (uncategorized = `other`). */
  readonly spendingByCategory: ReadonlyMap<string, Decimal>;
  readonly transactions: number;
  readonly cushionTopUp: Decimal;
  /** `income - spending`. */
  readonly surplus: Decimal;
  /** `max(0, surplus - cushion top-up)`. */
  readonly suggestedTransfer: Decimal;
}

export interface MonthClose {
  readonly year: number;
  readonly month: number;
  /** `YYYY-MM`. */
  readonly label: string;
  /** The month ended before `today`. */
  readonly complete: boolean;
  readonly baseCurrency: string;
  /** In budget-currency order (`budgetCurrencies`), then by code. */
  readonly currencies: readonly CurrencyClose[];
  readonly firstMonth: string | null;
  readonly lastMonth: string | null;
  readonly cushion: CushionState | null;
  readonly planned: PlannedContribution | null;
  readonly investmentsEnabled: boolean;
}

export type MonthParse =
  | { readonly ok: true; readonly year: number; readonly month: number }
  | { readonly ok: false; readonly error: "month must be YYYY-MM" };

/** Python `int(text)` of a base-10 literal (whitespace, sign, `_` between digits, Unicode digits). */
function pyInt(text: string): number | null {
  const s = Array.from(pyStrip(text));
  let i = 0;
  let negative = false;
  if (s[0] === "+" || s[0] === "-") {
    negative = s[0] === "-";
    i = 1;
  }
  let digits = "";
  let lastUnderscore = true; // no leading underscore
  for (; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "_") {
      if (lastUnderscore) return null;
      lastUnderscore = true;
      continue;
    }
    const d = unicodeDecimal(ch.codePointAt(0) as number);
    if (d < 0) return null;
    digits += String(d);
    lastUnderscore = false;
  }
  if (digits === "" || lastUnderscore) return null;
  const n = Number(digits);
  return negative ? -n : n;
}

/** `parse_month`: `YYYY-MM` -> (year, month); the API's 422 message otherwise. */
export function parseMonth(value: string): MonthParse {
  const bad = { ok: false, error: "month must be YYYY-MM" } as const;
  const parts = value.split("-");
  if (parts.length !== 2) return bad;
  const [yearS, monthS] = parts as [string, string];
  const year = pyInt(yearS);
  const month = pyInt(monthS);
  if (year === null || month === null) return bad;
  if (pyLen(yearS) !== 4 || month < 1 || month > 12 || year < 1900) return bad;
  return { ok: true, year, month };
}

/** `_shift`: the month `delta` months from `year-month`. */
export function shiftMonth(year: number, month: number, delta: number): readonly [number, number] {
  const index = year * 12 + (month - 1) + delta;
  return [Math.floor(index / 12), (((index % 12) + 12) % 12) + 1];
}

/**
 * `default_month`: the newest month with data, unless that is the running calendar month (or later),
 * then the month before `today`'s.
 */
export function defaultMonth(book: BudgetBook, today: IsoDate): readonly [number, number] {
  const ref = referenceDate(book);
  const [ty, tm] = yearMonth(today);
  if (ref === null) return shiftMonth(ty, tm, -1);
  const [ry, rm] = yearMonth(ref);
  if (ry > ty || (ry === ty && rm >= tm)) return shiftMonth(ty, tm, -1);
  return [ry, rm];
}

interface CloseBuilder {
  currency: string;
  income: Decimal;
  spending: Decimal;
  incomeByCategory: Map<string, Decimal>;
  spendingByCategory: Map<string, Decimal>;
  transactions: number;
}

function monthEnd(year: number, month: number): IsoDate {
  return `${monthLabel(year, month)}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

/** `month_flows` (as builders): income and spending of one month per currency, first-seen order. */
function flowBuilders(book: BudgetBook, year: number, month: number): Map<string, CloseBuilder> {
  const start = `${monthLabel(year, month)}-01`;
  const end = monthEnd(year, month);
  const own = bookOwnIbans(book);
  const out = new Map<string, CloseBuilder>();
  for (const t of book.transactions) {
    if (t.bookingDate < start || t.bookingDate > end || !isFlow(t, own)) continue;
    let cc = out.get(t.currency);
    if (cc === undefined) {
      cc = {
        currency: t.currency,
        income: ZERO_00,
        spending: ZERO_00,
        incomeByCategory: new Map(),
        spendingByCategory: new Map(),
        transactions: 0,
      };
      out.set(t.currency, cc);
    }
    cc.transactions++;
    if (t.amount.gte(ZERO)) {
      const cat = t.category || "income_other";
      cc.income = cc.income.add(t.amount);
      cc.incomeByCategory.set(cat, (cc.incomeByCategory.get(cat) ?? ZERO_00).add(t.amount));
    } else {
      const cat = t.category || "other";
      cc.spending = cc.spending.add(t.amount.neg());
      cc.spendingByCategory.set(cat, (cc.spendingByCategory.get(cat) ?? ZERO_00).sub(t.amount));
    }
  }
  return out;
}

function closeOf(b: CloseBuilder, cushionTopUp: Decimal): CurrencyClose {
  const surplus = b.income.sub(b.spending);
  return {
    ...b,
    cushionTopUp,
    surplus,
    suggestedTransfer: pyMax(ZERO_00, surplus.sub(cushionTopUp)),
  };
}

/** `month_flows`: income and spending of one month per currency (no cushion top-up). */
export function monthFlows(book: BudgetBook, year: number, month: number): CurrencyClose[] {
  return [...flowBuilders(book, year, month).values()].map((b) => closeOf(b, ZERO_00));
}

export interface MonthCloseOptions {
  /** The month to close; both or neither (default: `defaultMonth`). */
  readonly year?: number | null;
  readonly month?: number | null;
  /** Today's local date (completeness and the default month). */
  readonly today: IsoDate;
  /** The cushion rule (`accountIds` in the book's account id space). */
  readonly settings: BudgetSettings;
  /** Balances and account types for the cushion level. */
  readonly env: CushionEnv;
  /** Whether the investments module is enabled for the profile. */
  readonly investmentsEnabled: boolean;
  /** The strategy's plan; read by the caller only when investments is enabled. */
  readonly planned: PlannedContribution | null;
}

/** `month_close`: the close of one month for the profile. */
export function monthClose(book: BudgetBook, opts: MonthCloseOptions): MonthClose {
  let year = opts.year ?? null;
  let month = opts.month ?? null;
  if (year === null || month === null) [year, month] = defaultMonth(book, opts.today);
  const base = book.baseCurrency;
  const flows = flowBuilders(book, year, month);
  const [first, last] = monthBounds(book);
  const topUps = new Map<string, Decimal>();
  let cushion: CushionState | null = null;
  const rule = opts.settings.cushion;
  if (rule.enabled) {
    const currency = rule.currency || base;
    const cc = flows.get(currency);
    const surplus = cc === undefined ? ZERO_00 : cc.income.sub(cc.spending);
    cushion = cushionState(book, rule, year, month, surplus, opts.env);
    if (cc !== undefined) topUps.set(currency, cushion.topUp);
  }
  const order = new Map(budgetCurrencies(book).map((c, i) => [c.currency, i]));
  const rank = (c: string) => order.get(c) ?? order.size;
  const closes = [...flows.values()]
    .map((b) => closeOf(b, topUps.get(b.currency) ?? ZERO_00))
    .sort(
      (a, b) => rank(a.currency) - rank(b.currency) || codePointCompare(a.currency, b.currency),
    );
  return {
    year,
    month,
    label: monthLabel(year, month),
    complete: monthEnd(year, month) < opts.today,
    baseCurrency: base,
    currencies: closes,
    firstMonth: first,
    lastMonth: last,
    cushion,
    planned: opts.investmentsEnabled ? opts.planned : null,
    investmentsEnabled: opts.investmentsEnabled,
  };
}
