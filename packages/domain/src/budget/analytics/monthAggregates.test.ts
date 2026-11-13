// The month figures over monthly aggregates equal the book-based ones: `aggregate(book)` below is the
// oracle of what the store's `budget.months` deriver keeps (per account, currency, month and category
// or day, flow sums exact), and every `...FromRows` function over it must deep-equal its book twin
// (exponents of the decimals included) on the seeded household and on random books. Synthetic data
// only.

import { describe, expect, it } from "vitest";
import { ZERO_00 } from "../../core/index.js";
import type { IsoDate } from "../../dates.js";
import { D, type Decimal, decimalKey, ZERO } from "../../decimal.js";
import {
  type BudgetAccount,
  type BudgetBook,
  type BudgetTxn,
  bookOwnIbans,
  isFlow,
} from "./book.js";
import { budgetCurrencies, cashflowCoverageStart, monthlyCashflow } from "./cashflow.js";
import {
  type AccountFirstBooking,
  type CurrencyCountRow,
  categoryNormFromRows,
  coverageStartFromRows,
  currenciesFromRows,
  type MonthAggregates,
  type MonthCatRow,
  monthlyCashflowFromRows,
  spendingByCategoryFromRows,
  usualPayDayFromRows,
  usualToDateFromRows,
} from "./monthAggregates.js";
import { categoryNorm, usualPayDay, usualToDate } from "./projection.js";
import { spendingByCategory } from "./spending.js";
import { seedDemo } from "./testing/seedDemo.js";

interface CatAcc {
  currency: string;
  month: string;
  category: string | null;
  income: Decimal;
  expense: Decimal;
  n: number;
  flowN: number;
  uncategorizedN: number;
  uncategorizedExpense: Decimal;
  firstOutflow: number;
}

interface DayAcc {
  currency: string;
  month: string;
  day: number;
  n: number;
  income: Decimal;
  expense: Decimal;
  maxIncome: Decimal | null;
}

/**
 * The oracle: the book's rows grouped per (account, currency, month, category) and per (account,
 * currency, month, day), month groups in the book order of their first flow outflow (the store's
 * order), plus the counted accounts' first bookings and the per-account currency counts.
 */
function aggregate(book: BudgetBook): MonthAggregates & { currencies: CurrencyCountRow[] } {
  const own = bookOwnIbans(book);
  const cat = new Map<string, CatAcc>();
  const day = new Map<string, DayAcc>();
  const counted = new Set(
    book.accounts.filter((a) => a.removedAt === null && a.type !== "cash").map((a) => a.id),
  );
  const firsts = new Map<string, AccountFirstBooking>();
  const counts = new Map<string, CurrencyCountRow>();
  book.transactions.forEach((t, i) => {
    const month = t.bookingDate.slice(0, 7);
    const flow = isFlow(t, own);
    const outflow = flow && !t.amount.gte(ZERO);
    const ck = JSON.stringify([t.account, t.currency, month, t.category ?? ""]);
    let c = cat.get(ck);
    if (c === undefined) {
      c = {
        currency: t.currency,
        month,
        category: t.category ?? null,
        income: ZERO,
        expense: ZERO,
        n: 0,
        flowN: 0,
        uncategorizedN: 0,
        uncategorizedExpense: ZERO,
        firstOutflow: Number.POSITIVE_INFINITY,
      };
      cat.set(ck, c);
    }
    // A group keyed by '' stands for both null and '' (the store keeps '' for null): the first row's
    // value is kept, and both read as `other`.
    c.n++;
    const dk = JSON.stringify([t.account, t.currency, month, Number(t.bookingDate.slice(8, 10))]);
    let d = day.get(dk);
    if (d === undefined) {
      d = {
        currency: t.currency,
        month,
        day: Number(t.bookingDate.slice(8, 10)),
        n: 0,
        income: ZERO,
        expense: ZERO,
        maxIncome: null,
      };
      day.set(dk, d);
    }
    d.n++;
    if (flow) {
      c.flowN++;
      if (outflow) {
        c.expense = c.expense.add(t.amount.neg());
        d.expense = d.expense.add(t.amount.neg());
        c.firstOutflow = Math.min(c.firstOutflow, i);
        if (t.categorySource === "default") {
          c.uncategorizedN++;
          c.uncategorizedExpense = c.uncategorizedExpense.add(t.amount.neg());
        }
      } else {
        c.income = c.income.add(t.amount);
        d.income = d.income.add(t.amount);
        if (t.amount.gt(ZERO) && (d.maxIncome === null || t.amount.gt(d.maxIncome))) {
          // the store keeps the value only (canonical text)
          d.maxIncome = D(decimalKey(t.amount));
        }
      }
    }
    if (counted.has(t.account)) {
      const fk = `${t.account}|${t.currency}`;
      const f = firsts.get(fk);
      if (f === undefined || t.bookingDate < f.first) {
        firsts.set(fk, { account: t.account, currency: t.currency, first: t.bookingDate });
      }
    }
    const nk = `${t.account}|${t.currency}`;
    const u = counts.get(nk);
    counts.set(nk, {
      currency: t.currency,
      transactions: (u?.transactions ?? 0) + 1,
      first: u === undefined || t.bookingDate < u.first ? t.bookingDate : u.first,
      last: u === undefined || t.bookingDate > u.last ? t.bookingDate : u.last,
    });
  });
  const catRows: MonthCatRow[] = [...cat.values()]
    .sort((a, b) => a.firstOutflow - b.firstOutflow)
    .map(({ firstOutflow: _, ...r }) => r);
  return {
    cat: catRows,
    day: [...day.values()],
    firsts: [...firsts.values()],
    currencies: [...counts.values()],
  };
}

/**
 * The book's currencies, plus one it never uses. The book functions read an empty currency as the base
 * currency; the aggregate ones take the resolved currency, so a row currency "" is only ever counted.
 */
function currencies(book: BudgetBook): string[] {
  return [
    ...new Set([...book.transactions.map((t) => t.currency), book.baseCurrency, "CHF"]),
  ].filter((c) => c !== "");
}

function days(book: BudgetBook): IsoDate[] {
  const out = new Set<IsoDate>(["2026-11-30", "2026-02-28", "2026-02-15"]);
  for (const t of book.transactions) {
    const m = t.bookingDate.slice(0, 7);
    out.add(`${m}-01`);
    out.add(`${m}-15`);
    out.add(`${m}-28`);
    out.add(`${m}-${m.endsWith("02") ? "28" : "30"}`);
    out.add(t.bookingDate);
  }
  return [...out].filter((d) => !d.endsWith("02-30")).sort();
}

function expectEquivalent(book: BudgetBook): void {
  const agg = aggregate(book);
  for (const cur of currencies(book)) {
    expect(monthlyCashflowFromRows(agg.cat, cur)).toEqual(monthlyCashflow(book, cur));
    expect(coverageStartFromRows(agg.firsts, cur)).toEqual(cashflowCoverageStart(book, cur));
    for (const today of days(book)) {
      for (const n of [6, 2]) {
        expect(usualToDateFromRows(agg, cur, today, n)).toEqual(usualToDate(book, cur, today, n));
        expect(usualPayDayFromRows(agg, cur, today, n)).toEqual(usualPayDay(book, cur, today, n));
        expect(categoryNormFromRows(agg, cur, today, n)).toEqual(categoryNorm(book, cur, today, n));
      }
    }
    const months = new Set(book.transactions.map((t) => t.bookingDate.slice(0, 7)));
    const periods = [
      {},
      { year: 2026 },
      { quarter: 3 },
      ...[...months].map((m) => ({ year: Number(m.slice(0, 4)), month: Number(m.slice(5, 7)) })),
    ];
    for (const p of periods) {
      for (const lang of ["pl", "en"] as const) {
        expect(spendingByCategoryFromRows(agg.cat, cur, p, lang)).toEqual(
          spendingByCategory(book, cur, p, lang),
        );
      }
    }
  }
  expect(currenciesFromRows(agg.currencies, book.baseCurrency)).toEqual(budgetCurrencies(book));
}

// --------------------------------------------------------------------------- random books

/** mulberry32: a small seeded generator (tests only). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWN = "PL61109010140000071219812874";
const OWN_OTHER = "61109010140000071219812875";

function randomBook(seed: number): BudgetBook {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const accounts: BudgetAccount[] = [
    acc("a1", "checking", "PLN", OWN),
    acc("a2", "savings", "PLN", r() < 0.5 ? OWN_OTHER : null),
    acc("a3", "checking", "EUR", null),
    acc("cash", "cash", "PLN", null),
    { ...acc("gone", "checking", "PLN", "DE89370400440532013000"), removedAt: "2026-05-01" },
  ];
  const visible = accounts.filter((a) => a.removedAt === null);
  const amounts = [
    "-12.50",
    "-12.5",
    "-12",
    "-7.25",
    "-100.00",
    "-0.01",
    "-3.125",
    "0.00",
    "-0.00",
    "25.00",
    "9000.00",
    "9000",
    "100.5",
    "1.234",
  ];
  const categories = [null, null, "groceries", "fuel", "other", "", "transfer", "cash_withdrawal"];
  const ibans = [
    null,
    null,
    null,
    "PL 61 1090 1014 0000 0712 1981 2874",
    OWN_OTHER,
    "DE89370400440532013000",
    " ",
  ];
  const count = 20 + Math.floor(r() * 140);
  const transactions: BudgetTxn[] = [];
  for (let i = 0; i < count; i++) {
    const account = pick(visible);
    const month = 1 + Math.floor(r() * 9);
    const day = 1 + Math.floor(r() * (month === 2 ? 28 : 30));
    const currency =
      account.id === "a3" ? pick(["EUR", "EUR", "PLN"]) : pick(["PLN", "PLN", "EUR", ""]);
    transactions.push({
      key: `t${i}`,
      account: account.id,
      bookingDate: `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      amount: D(pick(amounts)),
      currency,
      counterpartyName: null,
      counterpartyIban: pick(ibans),
      description: null,
      reference: null,
      bankTransactionId: null,
      category: pick(categories),
      categorySource: pick(["default", "default", "rule", null]),
      isInternalTransfer: r() < 0.1,
      transferGroup: null,
      cashLegOf: null,
    });
  }
  const order = new Map(accounts.map((a, i) => [a.id, i]));
  const sorted = transactions
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (order.get(a.t.account) ?? 0) - (order.get(b.t.account) ?? 0) || a.i - b.i)
    .map(({ t }) => t);
  return { baseCurrency: pick(["PLN", "EUR"]), accounts, transactions: sorted };
}

function acc(id: string, type: string, currency: string, iban: string | null): BudgetAccount {
  return { id, name: id, iban, type, currency, active: true, removedAt: null };
}

describe("month aggregates equal the book-based month figures", () => {
  it("the seeded household", () => {
    expectEquivalent(seedDemo().book());
  });

  it.each(Array.from({ length: 40 }, (_, i) => i))("random book %i", (seed) => {
    expectEquivalent(randomBook(1_000 + seed));
  });

  it("equal category totals keep the book's first-seen order", () => {
    const book = randomBook(7);
    const tie: BudgetBook = {
      ...book,
      transactions: [
        txn("x1", "a1", "fuel", "-10.00"),
        txn("x2", "a1", "groceries", "-10.00"),
        txn("x3", "a2", "dining", "-10.00"),
        txn("x4", "a2", "fuel", "-0.00"),
      ],
    };
    const rows = aggregate(tie).cat;
    expect(spendingByCategoryFromRows(rows, "PLN").map((c) => c.category)).toEqual([
      "fuel",
      "groceries",
      "dining",
    ]);
    expect(spendingByCategoryFromRows(rows, "PLN")).toEqual(spendingByCategory(tie, "PLN"));
  });

  it("sums keep the rows' exponents (a sum of sums is the sum of the rows)", () => {
    const rows: MonthCatRow[] = [
      catRow("2026-03", "groceries", "12", 1),
      catRow("2026-03", "fuel", "0.125", 1),
    ];
    const [m] = monthlyCashflowFromRows(rows, "PLN");
    expect(m?.expense.toString()).toBe("12.125");
    expect(
      monthlyCashflowFromRows([catRow("2026-03", null, "12", 1)], "PLN")[0]?.expense.toString(),
    ).toBe("12.00");
    expect(ZERO_00.add(D("0")).toString()).toBe("0.00");
  });
});

function txn(key: string, account: string, category: string, amount: string): BudgetTxn {
  return {
    key,
    account,
    bookingDate: "2026-03-05",
    amount: D(amount),
    currency: "PLN",
    counterpartyName: null,
    counterpartyIban: null,
    description: null,
    reference: null,
    bankTransactionId: null,
    category,
    categorySource: "rule",
    isInternalTransfer: false,
    transferGroup: null,
    cashLegOf: null,
  };
}

function catRow(month: string, category: string | null, expense: string, n: number): MonthCatRow {
  return {
    currency: "PLN",
    month,
    category,
    income: ZERO,
    expense: D(expense),
    n,
    flowN: n,
    uncategorizedN: 0,
    uncategorizedExpense: ZERO,
  };
}
