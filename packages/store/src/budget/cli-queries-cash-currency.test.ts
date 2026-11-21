// `cashu cash` under data-safety rule 5: a cash pool's balance sums only the rows in the pool's own
// currency; rows in another currency (a foreign or malformed `txn.cashExpenseAdded`) are a separate
// part named after the pool plus the currency code, as net worth names it. Every row is invented.
// Hand-computed: PLN -12.00; EUR -3.00 - 5.00 = -8.00 (the old sum across currencies gave -20.00).
import { describe, expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import type { Store } from "../materialize.js";
import { run, testEnv } from "../testing/commands.js";
import { EventFactory, openTestStore, testUlid } from "../testing/store.js";
import { cashCliSnapshot } from "./cli-queries.js";
import { addCashExpense } from "./commands.js";

function syntheticPool(): { store: Store; gid: string; name: string } {
  const store = openTestStore();
  const env = testEnv();
  const ok = (r: { ok: boolean }, what: string) => {
    if (!r.ok) throw new Error(`synthetic ${what} refused`);
  };
  ok(
    run(store, env, createProfile, {
      slug: "synthetic-cash",
      name: "Synthetic cash",
      baseCurrency: "PLN",
      modules: ["budget"],
    }),
    "profile",
  );
  ok(
    run(store, env, addCashExpense, {
      amount: "12.00",
      title: "Synthetic coffee",
      category: "dining",
      onDate: "2026-03-18",
    }),
    "cash expense",
  );
  const pool = store.read<{ gid: string; name: string }>(
    "SELECT gid, name FROM accounts WHERE type = 'cash' AND currency = 'PLN'",
  )[0];
  if (pool === undefined) throw new Error("missing the synthetic cash pool");
  return { store, ...pool };
}

function addForeignRows(store: Store, pool: string): void {
  const f = new EventFactory("cccccccccccccccccccccccccccccccc", "01KE");
  const foreign = (n: number, bookingDate: string, amount: string) =>
    f.make("txn.cashExpenseAdded", testUlid("01KG", n), {
      account: pool,
      bookingDate,
      amount,
      currency: "EUR",
      title: "Synthetic euro coffee",
      category: "dining",
    });
  const applied = store.applyEnvelopes([
    foreign(1, "2026-02-10", "-3.00"),
    foreign(2, "2026-03-17", "-5.00"),
  ]).applied;
  if (applied !== 2) throw new Error("synthetic foreign rows not applied");
}

describe("cashu cash with a pool's rows in another currency", () => {
  it("keeps the single-currency balance and lists no part", () => {
    const { store } = syntheticPool();
    try {
      const snap = cashCliSnapshot(store.read.bind(store), null);
      expect(snap?.currency).toBe("PLN");
      expect(snap?.balance.quantize(-2).toString()).toBe("-12.00");
      expect(snap?.parts).toEqual([]);
      expect(snap?.rows).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("sums the pool's own currency only and shows the other one as a named part", () => {
    const { store, gid, name } = syntheticPool();
    try {
      addForeignRows(store, gid);
      const snap = cashCliSnapshot(store.read.bind(store), "pln");
      expect(snap?.currency).toBe("PLN");
      expect(snap?.balance.quantize(-2).toString()).toBe("-12.00");
      expect(
        snap?.parts.map((p) => [p.name, p.currency, p.balance.quantize(-2).toString()]),
      ).toEqual([[`${name} (EUR)`, "EUR", "-8.00"]]);
      // every movement is still listed, each in its own currency
      expect(snap?.rows.map((r) => [r.currency, r.amount.quantize(-2).toString()])).toEqual([
        ["PLN", "-12.00"],
        ["EUR", "-5.00"],
        ["EUR", "-3.00"],
      ]);
    } finally {
      store.close();
    }
  });
});
