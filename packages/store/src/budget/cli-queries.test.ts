import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { expect, it } from "vitest";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { cashCliSnapshot } from "./cli-queries.js";
import { addCashExpenseCli, importStatement, setTransactionCategory } from "./commands.js";

it("renders same-day cash ties and keeps a stable cutoff across rebuild", () => {
  const store = openTestStore();
  try {
    const env = testEnv();
    const txn: RawTransaction = {
      bookingDate: "2026-10-31",
      valueDate: null,
      amount: D("-20"),
      currency: "PLN",
      counterpartyName: "Synthetic ATM",
      counterpartyIban: null,
      description: "Synthetic withdrawal",
      reference: null,
      bankTransactionId: null,
      source: "csv",
      raw: { synthetic: true },
    };
    const imported = run(store, env, importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: "PL10000000000000000000000005",
        accountName: "Synthetic bank",
        currency: "PLN",
        transactions: [txn],
        balances: [],
        closingBalances: [],
      },
    });
    if (!imported.ok) throw new Error("synthetic import refused");
    const gid = imported.events.find((event) => event.type === "txn.imported")?.gid;
    if (!gid) throw new Error("missing synthetic transaction");
    expect(
      run(store, env, setTransactionCategory, { txn: gid, category: "cash_withdrawal" }).ok,
    ).toBe(true);
    expect(
      run(store, env, addCashExpenseCli, {
        amount: "5",
        title: "Synthetic expense",
        category: "dining",
        onDate: "2026-10-31",
      }).ok,
    ).toBe(true);
    const read = store.read.bind(store);
    const before = cashCliSnapshot(read, null);
    expect(before?.rows).toHaveLength(2);
    store.rebuild();
    expect(cashCliSnapshot(read, null)).toEqual(before);
    for (let i = 0; i < 41; i++) {
      expect(
        run(store, env, addCashExpenseCli, {
          amount: "1",
          title: `Synthetic tie ${i}`,
          category: "dining",
          onDate: "2026-10-31",
        }).ok,
      ).toBe(true);
    }
    const cutoff = cashCliSnapshot(read, null);
    expect(cutoff?.rows).toHaveLength(40);
    expect(cutoff?.balance.toString()).toBe("-26");
    expect(new Set(cutoff?.rows.map((row) => row.reference || row.description)).size).toBe(40);
    store.rebuild();
    expect(cashCliSnapshot(read, null)).toEqual(cutoff);
  } finally {
    store.close();
  }
});
