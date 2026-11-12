// Timing of the phone companion's reads on the 60k-transaction workload shape of `perf.test.ts`
// (3 accounts, 400 merchants, manual rules on most of them so a quarter of the rows stay
// uncategorized, monthly salaries, one balance per bank account). Synthetic data. An announced
// benchmark: CASHU_PERF=1 runs it, the default tier skips it. One `COMPANION_PERF {...}` line reports
// the median and the first run (ms) of each read.
//
// Budget (performance.md: 8 ms per live query on a UI-facing thread), lead decision 2026-11-12: the list
// reads (`budgetTransactions` pages, the uncategorized count and the triage rows) hold it and this test
// ASSERTS their medians. `core.companionMonth`, `core.attention` and `budgetSearch` are allowed over it in
// M1 (the phone's fixture is ~1.7k rows) and are only logged; M3 hardening moves them to derived monthly
// tables and FTS5 (plan.md).
import { sha1 } from "@noble/hashes/legacy.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { detGid } from "../gid.js";
import { companionQueries } from "../overview/companion.js";
import { defineQuery, type Query, type QueryArgs, runQuery } from "../query.js";
import { rng } from "../testing/random.js";
import { EventFactory, openTestStore, TEST_SALT, type TestEnvelope } from "../testing/store.js";
import {
  budgetSearch,
  budgetTransactions,
  budgetUncategorizedCount,
  budgetUncategorizedRows,
  type CompanionMonthArgs,
  companionMonth,
} from "./companion-queries.js";

/** The month's figures without the bills (the plain function `core.companionMonth` wraps). */
const monthFigures = defineQuery({
  id: "test.companionMonthFigures",
  run: (read, args: CompanionMonthArgs) => companionMonth(read, args),
});

/** performance.md: a live query on a UI-facing thread. */
const LIST_BUDGET_MS = 8;

const TODAY = "2026-03-20";
const DAYS = 750;
const ACCOUNTS = [
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "perf-1"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "mbank", "perf-2"]), currency: "PLN" },
  { gid: detGid(TEST_SALT, "accounts", ["ext", "erste", "perf-3"]), currency: "EUR" },
];

/** The day `n` days before `TODAY`. */
function dayBefore(n: number): string {
  const d = new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

const merchant = (m: number) => (m % 40 === 0 ? `ORLEN STACJA ${m}` : `SKLEP ${m}`);

function workload(): TestEnvelope[] {
  const f = new EventFactory("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "01JC");
  const r = rng(7);
  const events: TestEnvelope[] = [];
  for (const [i, a] of ACCOUNTS.entries()) {
    const bank = i === 2 ? "erste" : "mbank";
    events.push(
      f.make("account.opened", a.gid, {
        bank,
        externalId: `perf-${i + 1}`,
        iban: null,
        currency: a.currency,
        type: "checking",
        name: `Konto ${i + 1}`,
        keys: [`ext:${bank}:perf-${i + 1}`],
      }),
    );
  }
  const imported = (n: number, a: (typeof ACCOUNTS)[number], data: Record<string, unknown>) => {
    const hash = bytesToHex(sha1(utf8ToBytes(`companion-perf-${n}`)));
    events.push(
      f.make("txn.imported", detGid(TEST_SALT, "transactions", [a.gid, hash, "0"]), {
        account: a.gid,
        batch: null,
        valueDate: null,
        currency: a.currency,
        counterpartyIban: null,
        reference: null,
        bankTransactionId: null,
        source: "csv",
        dedupHash: hash,
        occurrence: 0,
        raw: {},
        ...data,
      }),
    );
  };
  for (let n = 0; n < 60_000; n++) {
    const a = ACCOUNTS[n % 3] as (typeof ACCOUNTS)[number];
    const amount =
      n % 500 === 0 ? "-1284.00" : `-${(1 + Math.floor(r() * 50000) / 100).toFixed(2)}`;
    imported(n, a, {
      bookingDate: dayBefore(n % DAYS),
      amount,
      counterpartyName: merchant(n % 400),
      description: "zakup kartą",
    });
  }
  for (let month = 0; month < 25; month++) {
    imported(100_000 + month, ACCOUNTS[0] as (typeof ACCOUNTS)[number], {
      bookingDate: dayBefore(10 + month * 30),
      amount: "9000.00",
      counterpartyName: "ACME SP Z O O",
      description: "wynagrodzenie",
    });
  }
  for (let m = 0; m < 300; m++) {
    events.push(
      f.make("categoryRule.set", detGid(TEST_SALT, "category_rules", [merchant(m)]), {
        merchantKey: merchant(m),
        category: ["groceries", "fuel", "shopping"][m % 3],
        source: "manual",
        locked: true,
      }),
    );
  }
  for (const a of ACCOUNTS) {
    events.push(
      f.make("balance.recorded", detGid(TEST_SALT, "balances", [a.gid, TODAY, "csv"]), {
        account: a.gid,
        date: TODAY,
        source: "csv",
        amount: "25000.00",
        currency: a.currency,
      }),
    );
  }
  return events;
}

/** Median and first run (ms) of `runs` executions. */
function time<A extends QueryArgs, R>(
  store: ReturnType<typeof openTestStore>,
  query: Query<A, R>,
  args: A,
  runs = 7,
): { median: number; first: number; value: R } {
  const times: number[] = [];
  let value: R | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    value = runQuery(store, query, args).value;
    times.push(performance.now() - t0);
  }
  const first = times[0] ?? 0;
  const sorted = [...times].sort((x, y) => x - y);
  const round = (x: number) => Math.round(x * 10) / 10;
  return {
    median: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
    first: round(first),
    value: value as R,
  };
}

describe("perf: companion reads on 60k transactions (announced benchmark)", () => {
  it.skipIf(process.env.CASHU_PERF !== "1")(
    "lists, search, month and attention",
    { timeout: 300_000 },
    () => {
      const store = openTestStore();
      try {
        const events = workload();
        for (let i = 0; i < events.length; i += 1000)
          store.applyEnvelopes(events.slice(i, i + 1000));
        expect(store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 60_025 }]);
        const companion = companionQueries();
        const list = time(store, budgetTransactions, { filter: "all" });
        const uncategorized = time(store, budgetTransactions, { filter: "uncategorized" });
        const nextPage = time(store, budgetTransactions, {
          filter: "all",
          before: list.value.next,
        });
        const count = time(store, budgetUncategorizedCount, {});
        const countMonth = time(store, budgetUncategorizedCount, {
          month: TODAY.slice(0, 7),
          currency: "PLN",
        });
        const triage = time(store, budgetUncategorizedRows, {
          month: TODAY.slice(0, 7),
          currency: "PLN",
        });
        const orlen = time(store, budgetSearch, { q: "orlen", lang: "pl" });
        const amount = time(store, budgetSearch, { q: "1284", lang: "pl" });
        const month = time(
          store,
          companion.month,
          { today: TODAY, currency: "PLN", lang: "pl" },
          3,
        );
        const figures = time(store, monthFigures, { today: TODAY, currency: "PLN", lang: "pl" }, 3);
        const attention = time(
          store,
          companion.attention,
          { today: TODAY, currency: "PLN", now: `${TODAY}T12:00:00.000Z` },
          3,
        );
        expect(list.value.rows).toHaveLength(100);
        expect(count.value).toBeGreaterThan(10_000);
        expect(orlen.value.total).toBeGreaterThan(1000);
        expect(amount.value.total).toBeGreaterThanOrEqual(120);
        const ms = (t: { median: number; first: number }) => ({ median: t.median, first: t.first });
        console.log(
          `COMPANION_PERF ${JSON.stringify({
            transactionsFirstPage: ms(list),
            transactionsNextPage: ms(nextPage),
            uncategorizedFirstPage: ms(uncategorized),
            uncategorizedCount: { ...ms(count), n: count.value },
            uncategorizedCountMonth: { ...ms(countMonth), n: countMonth.value },
            triageRowsMonth: { ...ms(triage), total: triage.value.total },
            overBudgetInM1: {
              searchOrlen: { ...ms(orlen), total: orlen.value.total },
              search1284: { ...ms(amount), total: amount.value.total },
              month: ms(month),
              monthFiguresWithoutBills: ms(figures),
              attention: ms(attention),
            },
          })}`,
        );
        for (const read of [list, nextPage, uncategorized, count, countMonth, triage])
          expect(read.median).toBeLessThanOrEqual(LIST_BUDGET_MS);
      } finally {
        store.close();
      }
    },
  );
});
