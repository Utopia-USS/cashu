// A cash row in another currency than its pool's is refused at storage (events.md 8.3): every command
// that books on a cash pool (`addCashExpense`, `addCashExpenseCli`, `setTransactionCategory` to
// `cash_withdrawal`, whose mirror leg books the row's currency) refuses with `cash_currency_mismatch`
// and writes nothing, instead of filing the amount under the pool's currency. Such a row that already
// sits in a vault, or arrives from another device or an older build, is still applied (no event is
// dropped) and reads as its own per-currency part. Synthetic data only; hand-computed values:
// PLN 1000.00 - 12.00 = 988.00, EUR -3.00 - 5.00 = -8.00 (a cross-currency sum would give 980.00 PLN).
import { budget, D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { type Command, runCommand } from "../command.js";
import { createProfile, openAccount, recordBalance } from "../core/commands.js";
import type { Envelope } from "../events/v1/envelope.js";
import { detGid } from "../gid.js";
import type { Store } from "../materialize.js";
import { shellSummary } from "../overview/networth.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { EventFactory, openTestStore, TEST_SALT, testUlid } from "../testing/store.js";
import {
  addCashExpense,
  addCashExpenseCli,
  CASH_CURRENCY_MISMATCH,
  importStatement,
  setTransactionCategory,
} from "./commands.js";
import { accountBalances } from "./companion-queries.js";

const TODAY = "2026-03-20";
const env = { today: TODAY, prices: null } as const;
const refused = { ok: false, reason: CASH_CURRENCY_MISMATCH };

const PROFILE = {
  slug: "synthetic-guard",
  name: "Synthetic guard",
  baseCurrency: "PLN",
  modules: ["budget"],
};

function profile(store: Store, e = testEnv()) {
  const out = run(store, e, createProfile, PROFILE);
  if (!out.ok) throw new Error("synthetic profile refused");
  return e;
}

/** The pool keyed `cash:EUR` opened in PLN (a malformed writer's account; nothing else makes one). */
function malformedEuroPool(store: Store, e: TestEnv): string {
  const out = run(store, e, openAccount, {
    bank: "manual",
    name: "Gotówka (EUR)",
    type: "cash",
    currency: "PLN",
    externalId: "cash:EUR",
  });
  if (!out.ok) throw new Error("synthetic pool refused");
  return (out.value as { account: string }).account;
}

const events = (store: Store) =>
  store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n;
const cashRows = (store: Store) =>
  store.read<{ amount: string; currency: string; pool: string }>(
    `SELECT t.amount, t.currency, a.currency AS pool FROM transactions t
     JOIN accounts a ON a.id = t.account_id WHERE a.type = 'cash' ORDER BY t.id`,
  );

const expense = (currency: string | null) => ({
  amount: "7.50",
  title: "Synthetic snack",
  category: "dining",
  currency,
  onDate: "2026-03-18",
});

function bankRow(currency: string): RawTransaction {
  return {
    bookingDate: "2026-03-10",
    valueDate: null,
    amount: D("-200.00"),
    currency,
    counterpartyName: "SYNTHETIC ATM",
    counterpartyIban: null,
    description: "atm",
    reference: "atm",
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: currency },
  };
}

function importBank(store: Store, e: TestEnv, currency: string, iban: string) {
  const out = run(store, e, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: iban,
      accountName: `Synthetic ${currency}`,
      currency,
      transactions: [bankRow(currency)],
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
  if (!out.ok) throw new Error("synthetic import refused");
  const txn = out.events.find((ev) => ev.type === "txn.imported")?.gid;
  if (txn === undefined) throw new Error("missing the synthetic bank row");
  return txn;
}

describe("commands that book on a cash pool refuse another currency than the pool's", () => {
  it("addCashExpense and its CLI twin refuse, write nothing and never relabel the amount", () => {
    const store = openTestStore();
    try {
      const e = profile(store);
      malformedEuroPool(store, e);
      const before = events(store);
      expect(run(store, e, addCashExpense, expense("EUR"))).toEqual(refused);
      expect(run(store, e, addCashExpense, expense("eur"))).toEqual(refused);
      expect(run(store, e, addCashExpenseCli, expense("EUR"))).toEqual(refused);
      expect(events(store)).toBe(before);
      expect(cashRows(store)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("books as before when the pool is in the booked currency (control)", () => {
    const store = openTestStore();
    try {
      const e = profile(store);
      expect(run(store, e, addCashExpense, expense(null)).ok).toBe(true);
      expect(run(store, e, addCashExpense, expense("EUR")).ok).toBe(true);
      expect(run(store, e, addCashExpenseCli, expense("EUR")).ok).toBe(true);
      expect(cashRows(store)).toEqual([
        { amount: "-7.50", currency: "PLN", pool: "PLN" },
        { amount: "-7.50", currency: "EUR", pool: "EUR" },
        { amount: "-7.50", currency: "EUR", pool: "EUR" },
      ]);
    } finally {
      store.close();
    }
  });

  it("refuses a cash withdrawal whose mirror leg would land on a pool in another currency", () => {
    const store = openTestStore();
    try {
      const e = profile(store);
      malformedEuroPool(store, e);
      const eur = importBank(store, e, "EUR", "PL10114000000000000000002222");
      const pln = importBank(store, e, "PLN", "PL10114000000000000000001111");
      const before = events(store);
      expect(
        run(store, e, setTransactionCategory, { txn: eur, category: budget.CASH_WITHDRAWAL }),
      ).toEqual(refused);
      expect(events(store)).toBe(before);
      // any other category on the same row, and a withdrawal in the pool's currency, still go through
      expect(run(store, e, setTransactionCategory, { txn: eur, category: "dining" }).ok).toBe(true);
      expect(
        run(store, e, setTransactionCategory, { txn: pln, category: budget.CASH_WITHDRAWAL }).ok,
      ).toBe(true);
      expect(cashRows(store)).toEqual([{ amount: "200.00", currency: "PLN", pool: "PLN" }]);
    } finally {
      store.close();
    }
  });
});

/** PLN bank 1000.00, a PLN pool with -12.00 PLN; returns the pool's DET gid. */
function standardVault(store: Store, log: unknown[] = []): { pool: string; e: TestEnv } {
  // every batch is applied to `store` and recorded in `log`, as another device would receive it
  const writer = {
    append(envs: readonly Envelope[]) {
      log.push(...envs);
      store.applyEnvelopes(envs);
    },
  };
  const run = <I, R>(s: Store, en: TestEnv, cmd: Command<I, R>, input: unknown) =>
    runCommand(s, writer, cmd, input, en);
  const e = testEnv();
  if (!run(store, e, createProfile, PROFILE).ok) throw new Error("synthetic profile refused");
  const bank = run(store, e, openAccount, {
    bank: "mbank",
    type: "checking",
    currency: "PLN",
    iban: "PL10114000000000000000001234",
  });
  if (!bank.ok) throw new Error("synthetic bank refused");
  const balance = run(store, e, recordBalance, {
    account: (bank.value as { account: string }).account,
    date: "2026-03-19",
    amount: "1000.00",
    source: "csv",
  });
  if (!balance.ok) throw new Error("synthetic balance refused");
  if (!run(store, e, addCashExpense, { ...expense(null), amount: "12.00" }).ok)
    throw new Error("synthetic expense refused");
  return { pool: detGid(TEST_SALT, "accounts", ["ext", "manual", "cash:PLN"]), e };
}

/** Two EUR expenses addressed to the PLN pool, as another device (or an older build) wrote them. */
function foreignRows(pool: string) {
  const f = new EventFactory("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "01KE");
  const row = (n: number, bookingDate: string, amount: string) =>
    f.make("txn.cashExpenseAdded", testUlid("01KF", n), {
      account: pool,
      bookingDate,
      amount,
      currency: "EUR",
      title: "Synthetic euro coffee",
      category: "dining",
    });
  return [row(1, "2026-02-10", "-3.00"), row(2, "2026-03-17", "-5.00")];
}

const netWorth = (store: Store) =>
  Object.entries(shellSummary(store.read.bind(store), env).networth).map(([c, v]) => [
    c,
    v.toString(),
  ]);
const poolBalances = (store: Store, pool: string) =>
  accountBalances(store.read.bind(store), TODAY)
    .filter((b) => b.id === pool)
    .map((b) => [b.currency, b.balance.toString()]);

describe("a mismatched cash row from sync or an older build", () => {
  it("is applied, kept and read as its own part; the guard never touches stored rows", () => {
    const store = openTestStore();
    try {
      const { pool, e } = standardVault(store);
      const out = store.applyEnvelopes(foreignRows(pool));
      expect([out.applied, out.parked, out.rejected.length]).toEqual([2, 0, 0]);
      const expected = [
        ["EUR", "-8.00"],
        ["PLN", "988.00"],
      ];
      expect(netWorth(store)).toEqual(expected);
      expect(poolBalances(store, pool)).toEqual([
        ["PLN", "-12.00"],
        ["EUR", "-8.00"],
      ]);
      // a new own-currency expense on the same pool still books; the euro rows stay
      expect(run(store, e, addCashExpense, { ...expense(null), amount: "1.00" }).ok).toBe(true);
      expect(netWorth(store)).toEqual([
        ["EUR", "-8.00"],
        ["PLN", "987.00"],
      ]);
      // a rebuild from the log folds the same view
      store.rebuild();
      expect(netWorth(store)).toEqual([
        ["EUR", "-8.00"],
        ["PLN", "987.00"],
      ]);
    } finally {
      store.close();
    }
  });

  it("converges whichever device's events arrive first", () => {
    const own = openTestStore();
    const source = openTestStore();
    const other = openTestStore();
    try {
      const mine: unknown[] = [];
      const { pool } = standardVault(source, mine);
      expect(mine.length).toBeGreaterThan(0);
      const foreign = foreignRows(pool);
      // own: the vault's events, then the foreign rows; other: the foreign rows first
      for (const [store, batches] of [
        [own, [mine, foreign]],
        [other, [foreign, mine]],
      ] as const) {
        for (const batch of batches) store.applyEnvelopes(batch);
        expect(netWorth(store)).toEqual([
          ["EUR", "-8.00"],
          ["PLN", "988.00"],
        ]);
        expect(poolBalances(store, pool)).toEqual([
          ["PLN", "-12.00"],
          ["EUR", "-8.00"],
        ]);
      }
    } finally {
      own.close();
      source.close();
      other.close();
    }
  });
});
