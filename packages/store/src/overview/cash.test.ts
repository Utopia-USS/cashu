import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { addCashExpense } from "../budget/commands.js";
import { createProfile } from "../core/commands.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { overviewCashWallet } from "./cash.js";

describe("the phone's cash wallet entry", () => {
  it("is the base currency's empty wallet until the first expense, then lists it newest first", () => {
    const store = openTestStore();
    const env = testEnv();
    expect(
      run(store, env, createProfile, {
        slug: "synthetic",
        name: "Synthetic",
        baseCurrency: "PLN",
        modules: ["budget"],
      }).ok,
    ).toBe(true);
    expect(runQuery(store, overviewCashWallet, {}).value).toMatchObject({
      exists: false,
      currency: "PLN",
      balance: D("0"),
      transactions: [],
    });
    for (const [title, onDate] of [
      ["Synthetic older", "2026-11-09"],
      ["Synthetic newer", "2026-11-11"],
    ] as const) {
      expect(
        run(store, env, addCashExpense, { amount: "12.40", title, category: "groceries", onDate })
          .ok,
      ).toBe(true);
    }
    const wallet = runQuery(store, overviewCashWallet, {}).value;
    expect(wallet.exists).toBe(true);
    expect(wallet.balance).toEqual(D("-24.80"));
    expect(wallet.transactions.map((row) => [row.date, row.title, row.category, row.kind])).toEqual(
      [
        ["2026-11-11", "Synthetic newer", "groceries", "expense"],
        ["2026-11-09", "Synthetic older", "groceries", "expense"],
      ],
    );
  });
});
