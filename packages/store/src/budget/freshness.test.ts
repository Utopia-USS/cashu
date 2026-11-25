// Bank data freshness of one vault: the newest finished import batch and the newest booking date of
// a visible bank account. Synthetic rows only.
import { D } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { describe, expect, it } from "vitest";
import { createProfile, removeAccount } from "../core/commands.js";
import { runQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { addCashExpense, importStatement } from "./commands.js";
import { dataFreshness } from "./freshness.js";

function row(date: string, amount: string, n: number): RawTransaction {
  return {
    bookingDate: date,
    valueDate: null,
    amount: D(amount),
    currency: "PLN",
    counterpartyName: "SYNTHETIC SHOP",
    counterpartyIban: null,
    description: "SYNTHETIC",
    reference: "SYNTHETIC",
    bankTransactionId: `SYN-${n}`,
    source: "csv",
    raw: { row: n },
  };
}

function statement(accountNumber: string, transactions: RawTransaction[]) {
  return {
    bank: "mbank",
    accountNumber,
    accountName: "Synthetic",
    currency: "PLN",
    transactions,
    balances: [],
    closingBalances: [],
  };
}

describe("dataFreshness", () => {
  it("is empty before any data", () => {
    const store = openTestStore();
    expect(runQuery(store, dataFreshness, undefined).value).toEqual({
      bankDataAt: null,
      bankSource: null,
      newestBooking: null,
    });
  });

  it("names the newest finished batch and the newest bank booking", () => {
    const store = openTestStore();
    const env = testEnv({ wall: Date.UTC(2026, 9, 1, 6, 40) });
    run(store, env, createProfile, { slug: "synthetic", name: "Synthetic", modules: ["budget"] });
    const first = run(store, env, importStatement, {
      statement: statement("99114000000000000000000001", [row("2026-09-28", "-10.00", 1)]),
      source: "csv",
    });
    if (!first.ok) throw new Error(`synthetic import refused: ${first.reason}`);
    env.advance(24 * 60 * 60 * 1000);
    const second = run(store, env, importStatement, {
      statement: statement("99114000000000000000000002", [row("2026-09-30", "-12.00", 2)]),
      source: "open_banking",
    });
    if (!second.ok) throw new Error(`synthetic import refused: ${second.reason}`);
    // A cash expense is not bank data, even when it is the newest row.
    run(store, env, addCashExpense, {
      amount: "5",
      title: "Synthetic cash",
      category: "groceries",
      onDate: "2026-10-02",
    });
    const fresh = runQuery(store, dataFreshness, undefined);
    expect(fresh.value).toEqual({
      bankDataAt: "2026-10-02T06:40:00.000Z",
      bankSource: "open_banking",
      newestBooking: "2026-09-30",
    });
    expect(fresh.tables).toEqual(new Set(["import_batches", "transactions", "accounts"]));

    // A removed account's rows no longer count.
    expect(run(store, env, removeAccount, { account: second.value.account }).ok).toBe(true);
    expect(runQuery(store, dataFreshness, undefined).value.newestBooking).toBe("2026-09-28");
  });
});
