// The per-group recurring detection the deriver runs (`budget.detectRecurringGroup` +
// `recurringOrder`, `budget.groupSeries`, and the domain's whole-book functions now built on them)
// against the frozen pre-refactor code (`testing/recurring-frozen.ts`) on random groups: monthly
// series with amount drift inside and outside the tolerance, price rises, extra charges, duplicate
// dates, noise purchases; categories filed `subscriptions`, unfiled, a spending category, an excluded
// one, or left to the engine; `minOccurrences` 1-4. Synthetic data only.
import { addDays, budget, D, type Decimal, format2, type IsoDate } from "@cashu/domain";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  detectRecurringPaymentsFrozen,
  recurringSeriesFrozen,
} from "../testing/recurring-frozen.js";
import { openTestStore } from "../testing/store.js";
import { budgetEngineContext } from "./read-models.js";

const PAYEES = ["ACME CLOUD", "KINO HELIOS", "NETFLIX COM", "BIEDRONKA 12"] as const;
const CURRENCIES = ["PLN", "EUR"] as const;
/** Decided claims (a per-row decision is the category) or null (the engine judges the row). */
const DECIDED = [null, "subscriptions", "other", "groceries", "housing"] as const;
/** Amounts around 100 (drift inside 15%: 103 / 116; outside: 85, 130) and others. */
const AMOUNTS = ["100.00", "103.00", "116.00", "85.00", "130.00", "29.99", "30.00", "55.50"];
const START: IsoDate = "2025-01-03";

interface Spec {
  readonly payee: number;
  readonly currency: number;
  readonly decided: number;
  readonly start: number;
  readonly gap: number;
  readonly count: number;
  readonly amounts: readonly number[];
  readonly jitter: readonly number[];
}

const series = fc.record({
  payee: fc.nat(PAYEES.length - 1),
  currency: fc.nat(CURRENCIES.length - 1),
  decided: fc.nat(DECIDED.length - 1),
  start: fc.nat(400),
  gap: fc.constantFrom(7, 14, 28, 30, 31, 33, 45),
  count: fc.integer({ min: 1, max: 7 }),
  amounts: fc.array(fc.nat(AMOUNTS.length - 1), { minLength: 1, maxLength: 3 }),
  jitter: fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 1, maxLength: 7 }),
});

interface Charge {
  readonly payee: string;
  readonly currency: string;
  readonly date: IsoDate;
  readonly amount: Decimal;
  readonly decided: string | null;
}

/** The rows of the specs in the given order (series interleave like a statement's rows). */
function charges(specs: readonly Spec[], order: readonly number[]): Charge[] {
  const all: Charge[] = [];
  for (const s of specs) {
    for (let k = 0; k < s.count; k++) {
      all.push({
        payee: PAYEES[s.payee] as string,
        currency: CURRENCIES[s.currency] as string,
        date: addDays(START, s.start + k * s.gap + (s.jitter[k % s.jitter.length] ?? 0)),
        amount: D(`-${AMOUNTS[s.amounts[k % s.amounts.length] as number]}`),
        decided: DECIDED[s.decided] ?? null,
      });
    }
  }
  return order.length === 0
    ? all
    : all
        .map((c, i) => ({ c, k: order[i % order.length] as number }))
        .sort((a, b) => a.k - b.k)
        .map((x) => x.c);
}

const recurringRow = (c: Charge): budget.RecurringRow => ({
  bookingDate: c.date,
  currency: c.currency,
  amount: c.amount,
  counterpartyName: c.payee,
  counterpartyIban: null,
  description: null,
  reference: null,
  isInternalTransfer: false,
  decided: c.decided === null ? null : { category: c.decided, source: "manual_txn" },
});

const budgetTxn = (c: Charge, i: number): budget.BudgetTxn => ({
  key: `t${i}`,
  account: "A",
  bookingDate: c.date,
  amount: c.amount,
  currency: c.currency,
  counterpartyName: c.payee,
  counterpartyIban: null,
  description: null,
  reference: null,
  bankTransactionId: null,
  category: c.decided,
  categorySource: c.decided === null ? null : "manual_txn",
  isInternalTransfer: false,
  transferGroup: null,
  cashLegOf: null,
});

const store = openTestStore();
afterAll(() => store.close());
const ctx = budgetEngineContext(store.read.bind(store), []);
const NOT_SUBSCRIPTION = budget.NOT_SUBSCRIPTION_CATEGORIES;
const NO_KEYS: ReadonlySet<string> = new Set();

/** The groups as the store builds them: judged entries per (payee, currency), in row order. */
function perGroup(rows: readonly budget.RecurringRow[], opts: budget.RecurringListOptions) {
  const groups = new Map<
    string,
    { payee: string; currency: string; entries: budget.RecurringGroupEntry[]; seqs: number[] }
  >();
  let seq = 0;
  for (const t of rows) {
    if (t.amount.gte(D("0"))) continue;
    const payee = budget.txnMerchantKey(t);
    if (!payee) continue;
    const category =
      t.decided && budget.TXN_DECIDED_SOURCES.has(t.decided.source) && t.decided.category
        ? t.decided.category
        : budget.categorize(t, ctx, NO_KEYS).category;
    if (NOT_SUBSCRIPTION.has(category)) continue;
    const key = JSON.stringify([payee, t.currency]);
    const g = groups.get(key) ?? { payee, currency: t.currency, entries: [], seqs: [] };
    g.entries.push({ date: t.bookingDate, amountKey: format2(t.amount.neg()), category });
    g.seqs.push(seq++);
    groups.set(key, g);
  }
  const found = [...groups.values()].flatMap((g) =>
    budget
      .detectRecurringGroup(g.payee, g.currency, g.entries, opts)
      .map((f) => ({ candidate: f.candidate, seq: g.seqs[f.first] as number })),
  );
  return budget.recurringOrder(found, (f) => f.seq).map((f) => f.candidate);
}

describe("the per-group recurring refactor equals the frozen whole-book code", () => {
  it("on random groups: detection, per-group detection and series", () => {
    let candidates = 0;
    fc.assert(
      fc.property(
        fc.array(series, { minLength: 1, maxLength: 6 }),
        fc.array(fc.nat(1000), { maxLength: 40 }),
        fc.integer({ min: 1, max: 4 }),
        fc.boolean(),
        (specs, order, minOccurrences, defaults) => {
          const list = charges(specs, order);
          const rows = list.map(recurringRow);
          const opts: budget.RecurringListOptions = defaults ? {} : { minOccurrences };
          const frozen = detectRecurringPaymentsFrozen(rows, NOT_SUBSCRIPTION, opts, (t, keys) =>
            budget.categorize(t, ctx, keys),
          );
          candidates += frozen.length;
          expect(budget.detectRecurringPayments(rows, ctx, NOT_SUBSCRIPTION, opts)).toEqual(frozen);
          expect(perGroup(rows, opts)).toEqual(frozen);
          // series: the whole book, then each group alone as the deriver forms them
          const book: budget.BudgetBook = {
            baseCurrency: "PLN",
            accounts: [],
            transactions: list.map(budgetTxn),
          };
          const want = recurringSeriesFrozen(frozen, book);
          expect(budget.recurringSeries(frozen, book)).toEqual(want);
          for (const payee of PAYEES) {
            for (const currency of CURRENCIES) {
              const own = frozen.filter((c) => c.counterparty === payee && c.currency === currency);
              if (own.length === 0) continue;
              const groupRows = book.transactions.filter(
                (t) => budget.txnMerchantKey(t) === payee && t.currency === currency,
              );
              expect(budget.groupSeries(own, groupRows)).toEqual(
                own.map((c) => want.find((s) => s.candidate === c)?.rows),
              );
            }
          }
        },
      ),
      { numRuns: process.env.CASHU_TEST_TIER === "exhaustive" ? 3000 : 300, seed: 97_001 },
    );
    // the generator reaches the interesting cases (candidates found), not only empty answers
    expect(candidates).toBeGreaterThan(50);
  });
});
