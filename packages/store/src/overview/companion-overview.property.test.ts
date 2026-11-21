// The phone's overview read models (`OverviewSources.companionReads`: the budget net worth from the
// month deriver's day sums, the hero's monthly cashflow from its month groups, the summary's net worth
// alone) and the phone's budget screen queries (currencies, spending over the month aggregates) equal the book-based ones they replace, on random statements (several accounts and
// currencies, amounts of every scale, balance snapshots, cash withdrawals with their cash legs,
// re-categorized and removed accounts) and on the categories and transfers scripts. Synthetic data.
import { D, type IsoDate } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { importStatement, setTransactionCategory } from "../budget/commands.js";
import { budgetCompanionCurrencies, budgetCompanionSpending } from "../budget/companion-queries.js";
import { budgetScreenCurrencies, budgetScreenSpending } from "../budget/screen-queries.js";
import { createProfile, removeAccount } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { runQuery } from "../query.js";
import { categoryScript, deliver } from "../testing/category-script.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { transferScript } from "../testing/transfer-script.js";
import { accountsQuery, assetsQuery } from "./accounts.js";
import { bananaScaleView } from "./bananas.js";
import {
  heroView,
  netWorthNow,
  netWorthSeries,
  type OverviewSources,
  shellSummary,
} from "./networth.js";

const BOOK: OverviewSources = {};
const PHONE: OverviewSources = { companionReads: true };
const env = (today: IsoDate) => ({ today, prices: null });

/** Every phone read model against its book-based twin on `store`, seen from `today`. */
function expectPhoneOverviewEqual(store: Store, today: IsoDate): void {
  const read = store.read.bind(store);
  expect(heroView(read, env(today), PHONE)).toEqual(heroView(read, env(today), BOOK));
  expect(netWorthNow(read, env(today), PHONE)).toEqual({
    networth: shellSummary(read, env(today), BOOK).networth,
  });
  expect(bananaScaleView(read, env(today), PHONE)).toEqual(bananaScaleView(read, env(today), BOOK));
  for (const granularity of ["daily", "weekly", "monthly"]) {
    for (const scope of ["total", "liquid"]) {
      for (const currency of [null, "EUR"]) {
        const args = { today, lang: "pl" as const, granularity, scope, currency };
        expect(netWorthSeries(read, args, { prices: null }, PHONE)).toEqual(
          netWorthSeries(read, args, { prices: null }, BOOK),
        );
      }
    }
  }
  const ctx = { prices: null };
  expect(runQuery(store, budgetCompanionCurrencies, { today }).value).toEqual(
    runQuery(store, budgetScreenCurrencies, { today }).value,
  );
  for (const currency of ["", "PLN", "EUR"]) {
    for (const period of [
      {},
      { year: 2026 },
      { year: 2026, month: 7 },
      { year: 2026, quarter: 3 },
    ]) {
      for (const lang of ["pl", "en"] as const) {
        const args = { today, currency, period, lang };
        expect(runQuery(store, budgetCompanionSpending, args).value).toEqual(
          runQuery(store, budgetScreenSpending, args).value,
        );
      }
    }
  }
  expect(runQuery(store, accountsQuery(ctx, PHONE), { today }).value).toEqual(
    runQuery(store, accountsQuery(ctx, BOOK), { today }).value,
  );
  expect(runQuery(store, assetsQuery(ctx, PHONE), { today }).value).toEqual(
    runQuery(store, assetsQuery(ctx, BOOK), { today }).value,
  );
}

const DAYS = Array.from({ length: 40 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 6, 1 + i * 3));
  return d.toISOString().slice(0, 10);
});
const day = fc.constantFrom(...DAYS);
/** Amounts of every scale ("-12", "-12.5", "-12.50", "0.00"), mostly outflows. */
const amount = fc
  .tuple(fc.integer({ min: -90_000, max: 40_000 }), fc.constantFrom(0, 1, 2))
  .map(([n, scale]) => (scale === 0 ? String(Math.trunc(n / 100)) : (n / 100).toFixed(scale)));
const ACCOUNTS = [
  { bank: "mbank", iban: "PL61109010140000071219812874", currency: "PLN", type: "checking" },
  { bank: "pekao", iban: "PL27114020040000300201355387", currency: "PLN", type: "savings" },
  { bank: "mbank", iban: "PL10105000997603123456789123", currency: "EUR", type: "checking" },
] as const;
const row = fc.record({
  date: day,
  amount,
  merchant: fc.constantFrom("SKLEP A", "KINO B", "WYNAGRODZENIE TEST", "PRACODAWCA TEST", null),
});
const statement = fc.record({
  account: fc.constantFrom(...ACCOUNTS),
  rows: fc.array(row, { minLength: 1, maxLength: 12 }),
  balances: fc.array(fc.record({ date: day, amount }), { maxLength: 3 }),
});
const script = fc.record({
  statements: fc.array(statement, { minLength: 1, maxLength: 5 }),
  /** Indexes of rows turned into cash withdrawals (each adds a cash leg on the pool). */
  withdrawals: fc.array(fc.nat(60), { maxLength: 4 }),
  removeFirst: fc.boolean(),
  today: day,
});

function raw(
  date: string,
  value: string,
  currency: string,
  merchant: string | null,
  n: number,
): RawTransaction {
  return {
    bookingDate: date,
    valueDate: null,
    amount: D(value),
    currency,
    counterpartyName: merchant,
    counterpartyIban: null,
    description: merchant === null ? `WYPLATA ${n}` : null,
    // The employer as the payee, the salary keyword only in the title: the categorizer's fallback.
    reference: merchant === "PRACODAWCA TEST" ? `WYNAGRODZENIE ${n}` : `REF ${n}`,
    bankTransactionId: null,
    source: "csv",
    raw: { n },
  };
}

type Script = typeof script extends fc.Arbitrary<infer S> ? S : never;

function buildStore(s: Script): Store {
  const store = openTestStore({ companionReads: true });
  const testenv = testEnv();
  const must = (out: { ok: boolean; reason?: string }) => {
    if (!out.ok) throw new Error(out.reason);
  };
  must(
    run(store, testenv, createProfile, {
      slug: "p",
      name: "P",
      baseCurrency: "PLN",
      modules: ["budget", "assets", "loans", "investments"],
    }),
  );
  let n = 0;
  for (const st of s.statements) {
    const rows = [...st.rows]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((r, i) => raw(r.date, r.amount, st.account.currency, r.merchant, n + i));
    n += rows.length;
    must(
      run(store, testenv, importStatement, {
        statement: {
          bank: st.account.bank,
          accountNumber: st.account.iban,
          accountName: null,
          currency: st.account.currency,
          transactions: rows,
          balances: [],
          closingBalances: st.balances.map((b) => ({ date: b.date, amount: D(b.amount) })),
        },
        accountType: st.account.type,
      }),
    );
  }
  const outflows = store.read<{ gid: string }>(
    "SELECT gid FROM transactions WHERE amount LIKE '-%' ORDER BY id",
  );
  for (const i of s.withdrawals) {
    const gid = outflows[i % Math.max(outflows.length, 1)]?.gid;
    if (gid !== undefined) {
      run(store, testenv, setTransactionCategory, { txn: gid, category: "cash_withdrawal" });
    }
  }
  if (s.removeFirst) {
    const first = store.read<{ gid: string }>(
      "SELECT gid FROM accounts WHERE type != 'cash' ORDER BY id LIMIT 1",
    )[0]?.gid;
    if (first !== undefined) run(store, testenv, removeAccount, { account: first });
  }
  return store;
}

describe("property: the phone's overview equals the book-based overview", () => {
  it.each([0, 1, 2, 3])("random statements, balances and cash legs: seed %i", (i) => {
    fc.assert(
      fc.property(script, (s) => {
        const store = buildStore(s);
        expectPhoneOverviewEqual(store, s.today);
        expectPhoneOverviewEqual(store, "2026-12-31");
        store.close();
      }),
      { numRuns: 12, seed: 47_000 + i },
    );
  });

  it.each([0, 1])("categories and transfers scripts: seed %i", (i) => {
    for (const source of [categoryScript, transferScript]) {
      fc.assert(
        fc.property(source, fc.integer({ min: 1, max: 1_000_000 }), (events, seed) => {
          const store = deliver(events, seed);
          for (const today of ["2026-06-15", "2026-10-31"]) expectPhoneOverviewEqual(store, today);
          store.close();
        }),
        { numRuns: 6, seed: 48_000 + i },
      );
    }
  });

  it("covers a bank walk-back, a cash pool and a currency the hero converts", () => {
    // The generator's shapes are present: a balance anchoring older days and a cash pool.
    const store = buildStore({
      statements: [
        {
          account: {
            bank: "mbank",
            iban: "PL61109010140000071219812874",
            currency: "PLN",
            type: "checking",
          },
          rows: [
            { date: "2026-07-01", amount: "-12.5", merchant: "SKLEP A" },
            { date: "2026-07-01", amount: "-3.40", merchant: null },
            { date: "2026-08-10", amount: "100", merchant: "KINO B" },
            { date: "2026-07-10", amount: "5000.00", merchant: "WYNAGRODZENIE TEST" },
            { date: "2026-08-10", amount: "5100.00", merchant: "WYNAGRODZENIE TEST" },
          ],
          balances: [{ date: "2026-08-10", amount: "1000.00" }],
        },
      ],
      withdrawals: [1],
      removeFirst: false,
      today: "2026-09-01",
    });
    const read = store.read.bind(store);
    const types = store.read<{ type: string }>("SELECT DISTINCT type FROM accounts ORDER BY type");
    expect(types.map((t) => t.type)).toEqual(["cash", "checking"]);
    const series = netWorthSeries(
      read,
      { today: "2026-09-01", lang: "pl", granularity: "daily" },
      { prices: null },
      PHONE,
    );
    expect(series.points.length).toBeGreaterThan(1);
    expect(bananaScaleView(read, env("2026-09-01"), PHONE)?.anchor).toBe("salary");
    expectPhoneOverviewEqual(store, "2026-09-01");
    store.close();
  });

  it("keeps the book's order of categories with equal spending", () => {
    // Two accounts, one outflow each of the same amount: `spendingByCategory` lists the categories
    // in book order (account, then row) on equal amounts.
    const store = buildStore({
      statements: [
        {
          account: ACCOUNTS[0],
          rows: [{ date: "2026-07-04", amount: "-10.00", merchant: "KINO B" }],
          balances: [],
        },
        {
          account: ACCOUNTS[1],
          rows: [{ date: "2026-07-01", amount: "-10.00", merchant: "SKLEP A" }],
          balances: [],
        },
      ],
      withdrawals: [],
      removeFirst: false,
      today: "2026-07-31",
    });
    const testenv = testEnv({ seed: 3 });
    const [first, second] = store.read<{ gid: string }>(
      "SELECT t.gid FROM transactions t ORDER BY t.account_id, t.id",
    );
    run(store, testenv, setTransactionCategory, { txn: first?.gid, category: "transport" });
    run(store, testenv, setTransactionCategory, { txn: second?.gid, category: "groceries" });
    const args = { today: "2026-07-31", currency: "PLN", period: {}, lang: "pl" as const };
    const book = runQuery(store, budgetScreenSpending, args).value;
    expect(book.rows.map((r) => r.category)).toEqual(["transport", "groceries"]);
    expect(runQuery(store, budgetCompanionSpending, args).value).toEqual(book);
    store.close();
  });
});
