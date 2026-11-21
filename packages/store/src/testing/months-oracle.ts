// The month-aggregates oracle of the store tests (M3): the `budget.months` tables recomputed from a
// plain read of every row (the `budgetBook` row set before its removed-account filter, `budget.isFlow`
// over the book's own IBANs), written independently of the deriver; and the aggregate-based month
// queries compared with their book-based originals (`testing/book-month-functions.ts`). Synthetic
// data only.
import { budget, core, D, type Decimal, decimalKey, ZERO } from "@cashu/domain";
import fc from "fast-check";
import { expect } from "vitest";
import {
  accountBalances,
  budgetUncategorizedCount,
  companionMonth,
} from "../budget/companion-queries.js";
import type { Store } from "../materialize.js";
import { runQuery } from "../query.js";
import { accountBalancesFromBook, companionMonthFromBook } from "./book-month-functions.js";
import { type categoryScript, deliver } from "./category-script.js";

interface ViewRow {
  id: number;
  gid: string;
  account_id: number;
  account: string;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_iban: string | null;
  category: string | null;
  category_source: string | null;
  is_internal_transfer: number;
}

/**
 * The deriver's tables as stored, in key order: both month tables and its row memory
 * (`fold_month_rows`: a stale memory row would show only in a later step's recompute).
 */
export function monthTables(store: Store): unknown[] {
  return [
    store.read("SELECT * FROM fold_month_cat ORDER BY account_id, currency, month, category"),
    store.read("SELECT * FROM fold_month_day ORDER BY account_id, currency, month, day"),
    store.read("SELECT * FROM fold_month_rows ORDER BY leg, row"),
  ];
}

/** The month tables the rows give (same shape and order as `monthTables`). */
function expectedTables(store: Store): unknown[] {
  const read = store.read.bind(store);
  const accounts = read<{ gid: string; iban: string | null }>("SELECT gid, iban FROM accounts");
  const own = core.ownIbans(accounts); // `bookOwnIbans`: every account, removed ones too
  const rows = read<ViewRow>(
    `SELECT t.id, t.gid, t.account_id, v.gid AS account, t.booking_date, t.amount, t.currency,
       t.counterparty_iban, t.category, t.category_source, t.is_internal_transfer
     FROM transactions t JOIN view_ids v ON v.id = t.account_id ORDER BY t.id`,
  );
  const cat = new Map<string, Record<string, unknown>>();
  const day = new Map<string, Record<string, unknown>>();
  const add = (x: unknown, y: Decimal) => (x as Decimal).add(y);
  for (const r of rows) {
    const t: budget.BudgetTxn = {
      key: r.gid,
      account: r.account,
      bookingDate: r.booking_date,
      amount: D(r.amount),
      currency: r.currency,
      counterpartyName: null,
      counterpartyIban: r.counterparty_iban,
      description: null,
      reference: null,
      bankTransactionId: null,
      category: r.category,
      categorySource: r.category_source,
      isInternalTransfer: r.is_internal_transfer === 1,
      transferGroup: null,
      cashLegOf: null,
    };
    const month = r.booking_date.slice(0, 7);
    const dayOf = Number(r.booking_date.slice(8, 10));
    const ck = JSON.stringify([r.account_id, r.currency, month, r.category ?? ""]);
    const c = cat.get(ck) ?? {
      account_id: r.account_id,
      currency: r.currency,
      month,
      category: r.category ?? "",
      income: ZERO,
      expense: ZERO,
      n: 0,
      flow_n: 0,
      net: ZERO,
      uncategorized_n: 0,
      uncategorized_expense: ZERO,
      first_outflow: null,
    };
    cat.set(ck, c);
    const dk = JSON.stringify([r.account_id, r.currency, month, dayOf]);
    const d = day.get(dk) ?? {
      account_id: r.account_id,
      currency: r.currency,
      month,
      day: dayOf,
      n: 0,
      income: ZERO,
      expense: ZERO,
      max_income: null,
      net: ZERO,
    };
    day.set(dk, d);
    c.n = (c.n as number) + 1;
    d.n = (d.n as number) + 1;
    c.net = add(c.net, t.amount);
    d.net = add(d.net, t.amount);
    if (!budget.isFlow(t, own)) continue;
    c.flow_n = (c.flow_n as number) + 1;
    if (t.amount.gte(ZERO)) {
      c.income = add(c.income, t.amount);
      d.income = add(d.income, t.amount);
      if (t.amount.gt(ZERO) && (d.max_income === null || t.amount.gt(d.max_income as Decimal))) {
        d.max_income = t.amount;
      }
    } else {
      c.expense = add(c.expense, t.amount.neg());
      d.expense = add(d.expense, t.amount.neg());
      if (c.first_outflow === null) c.first_outflow = r.id;
      if (t.categorySource === "default") {
        c.uncategorized_n = (c.uncategorized_n as number) + 1;
        c.uncategorized_expense = add(c.uncategorized_expense, t.amount.neg());
      }
    }
  }
  const text = (o: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        k === "max_income" && v !== null
          ? decimalKey(v as Decimal)
          : v instanceof Object && "digits" in v
            ? String(v)
            : v,
      ]),
    );
  return [[...cat.values()].map(text), [...day.values()].map(text)];
}

/** Both sides in one key order. */
function sqlOrder(tables: unknown[]): unknown[] {
  const key = (r: Record<string, unknown>) =>
    JSON.stringify([r.account_id, r.currency, r.month, r.category ?? r.day]);
  return tables.map((rows) =>
    [...(rows as Record<string, unknown>[])].sort((a, b) =>
      key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0,
    ),
  );
}

/** The month tables equal the recompute from every row. */
export function expectMonthsRecomputed(store: Store): void {
  expect(sqlOrder(monthTables(store).slice(0, 2))).toEqual(sqlOrder(expectedTables(store)));
}

export interface MonthRequest {
  readonly today: string;
  readonly month: string | null;
  readonly currency: string;
}

/** A few month requests: the running, a past and a future month, base and other currencies. */
const REQUESTS: readonly MonthRequest[] = [
  { today: "2026-10-20", month: null, currency: "" },
  { today: "2026-10-31", month: null, currency: "PLN" },
  { today: "2026-11-05", month: "2026-10", currency: "" },
  { today: "2026-10-20", month: "2026-08", currency: "EUR" },
  { today: "2026-07-15", month: "2026-09", currency: "" },
  { today: "2026-10-02", month: null, currency: "" },
];

/**
 * The aggregate-based month figures and balances equal the book-based ones (`budgetBook`, every row),
 * and the uncategorized count of a month and currency equals the month's own count.
 */
export function expectMonthQueriesEqual(
  store: Store,
  requests: readonly MonthRequest[] = REQUESTS,
  balanceDays: readonly string[] = ["2026-06-30", "2026-10-04", "2026-10-20", "2027-01-01"],
): void {
  const read = store.read.bind(store);
  for (const r of requests) {
    for (const lang of ["pl", "en"] as const) {
      const args = { today: r.today, month: r.month, currency: r.currency, lang };
      const month = companionMonth(read, args);
      expect(month).toEqual(companionMonthFromBook(read, args));
      expect(
        runQuery(store, budgetUncategorizedCount, { month: month.month, currency: month.currency })
          .value,
      ).toBe(month.uncategorized.count);
    }
  }
  for (const today of balanceDays) {
    expect(accountBalances(read, today)).toEqual(accountBalancesFromBook(read, today));
  }
}

/**
 * The month-aggregates property over a random budget script (the categories or the transfers one):
 * after every batch the tables equal the recompute from the rows, the incremental derivation equals
 * `deriveAll` (`rederive`) and the aggregate-based queries equal the book-based ones; a rebuild keeps
 * the tables. Used by `budget/derive/months.property.test.ts` and its exhaustive twin.
 */
export const monthsProperty = (script: typeof categoryScript) =>
  fc.property(script, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
    const a = deliver(events, seed, (s) => {
      expectMonthsRecomputed(s);
      const incremental = monthTables(s);
      expect(s.rederive().touchedTables).toEqual(new Set());
      expect(monthTables(s)).toEqual(incremental);
      expectMonthQueriesEqual(s);
    });
    a.rebuild();
    expectMonthsRecomputed(a);
    expectMonthQueriesEqual(a);
  });
