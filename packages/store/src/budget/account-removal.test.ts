// Removing a bank account from view: direct commands, the agent's proposal and its approval.
// Synthetic accounts only.
import { budget, D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { createProfile, openAccount } from "../core/commands.js";
import { approvePrepared, failApprovedProposal } from "../core/proposal-commands.js";
import { proposalExecution } from "../core/proposal-execution.js";
import { accountByGid } from "../core/queries.js";
import type { Store } from "../materialize.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import {
  prepareAccountRemoval,
  proposeAccountRemoval,
  removeBankAccount,
  restoreBankAccount,
} from "./account-removal.js";
import { importStatement } from "./commands.js";
import { budgetBook } from "./read-models.js";

const read = (store: Store) => store.read.bind(store);

function setup(type = "checking") {
  const store = openTestStore();
  const env = testEnv();
  const opened = run(store, env, openAccount, {
    bank: "testbank",
    name: "Konto testowe",
    type,
    currency: "PLN",
  });
  if (!opened.ok) throw new Error("synthetic account refused");
  return { store, env, account: opened.value.account };
}

const removed = (store: Store, account: string) => accountByGid(read(store), account)?.removed;

describe("removeBankAccount / restoreBankAccount", () => {
  it("hides a bank account and brings it back, idempotently", () => {
    const { store, env, account } = setup();
    expect(run(store, env, removeBankAccount, { account })).toMatchObject({
      ok: true,
      value: null,
    });
    expect(removed(store, account)).toBe(true);
    expect(run(store, env, removeBankAccount, { account }).ok).toBe(true);
    expect(run(store, env, restoreBankAccount, { account }).ok).toBe(true);
    expect(removed(store, account)).toBe(false);
  });

  it("refuses accounts that are not budget bank accounts", () => {
    for (const type of ["cash", "property", "brokerage"]) {
      const { store, env, account } = setup(type);
      expect(run(store, env, removeBankAccount, { account })).toEqual({
        ok: false,
        reason: "no_bank_account",
      });
      expect(removed(store, account)).toBe(false);
    }
    const { store, env } = setup();
    expect(run(store, env, removeBankAccount, { account: "01JUNKNOWNACCOUNTGID00000" }).ok).toBe(
      false,
    );
  });
});

describe("account_removal proposals", () => {
  const propose = (store: Store, env: ReturnType<typeof testEnv>, account: string) =>
    run(store, env, proposeAccountRemoval, {
      account,
      label: "Testbank checking 1",
      reason: "The owner closed this account.",
    });

  it("creates one pending proposal per account, with the generated label as summary value", () => {
    const { store, env, account } = setup();
    const out = propose(store, env, account);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(proposalExecution(read(store), out.value.proposalGid)).toMatchObject({
      kind: "account_removal",
      status: "pending",
      source: "agent",
      reason: "The owner closed this account.",
      payload: { account, summary_params: { account: "Testbank checking 1" } },
    });
    expect(propose(store, env, account)).toEqual({ ok: false, reason: "already_proposed" });
    expect(removed(store, account)).toBe(false); // nothing changes before the owner approves
  });

  it("refuses a removed or non-bank account", () => {
    const { store, env, account } = setup();
    run(store, env, removeBankAccount, { account });
    expect(propose(store, env, account)).toEqual({ ok: false, reason: "already_removed" });
    const cash = setup("cash");
    expect(propose(cash.store, cash.env, cash.account)).toEqual({
      ok: false,
      reason: "no_bank_account",
    });
  });

  it("removes the account on approval, on any device, and restores it when the approval fails", () => {
    const { store, account } = setup();
    const follower = testEnv({ holder: false, seed: 2, device: "f".repeat(32) });
    const out = propose(store, follower, account);
    if (!out.ok) throw new Error("proposal refused");
    const gid = out.value.proposalGid;
    const snapshot = proposalExecution(read(store), gid);
    if (!snapshot) throw new Error("no proposal");
    const prepared = prepareAccountRemoval(read(store), snapshot);
    if (!prepared.ok) throw new Error(prepared.reason);
    const approved = run(store, follower, approvePrepared(prepared.value), {});
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(proposalExecution(read(store), gid)).toMatchObject({
      status: "approved",
      result: { removed: account },
    });
    expect(removed(store, account)).toBe(true);
    const failed = run(store, follower, failApprovedProposal, {
      proposalGid: gid,
      approvalEid: approved.value.approvalEid,
      result: { error_code: "synthetic" },
    });
    expect(failed.ok).toBe(true);
    expect(removed(store, account)).toBe(false); // the caused removal is revoked
  });

  it("refuses to approve when the account was removed meanwhile", () => {
    const { store, env, account } = setup();
    const out = propose(store, env, account);
    if (!out.ok) throw new Error("proposal refused");
    const snapshot = proposalExecution(read(store), out.value.proposalGid);
    if (!snapshot) throw new Error("no proposal");
    const prepared = prepareAccountRemoval(read(store), snapshot);
    if (!prepared.ok) throw new Error(prepared.reason);
    run(store, env, removeBankAccount, { account });
    expect(run(store, env, approvePrepared(prepared.value), {})).toEqual({
      ok: false,
      reason: "account_unavailable",
    });
    expect(prepareAccountRemoval(read(store), snapshot)).toEqual({
      ok: false,
      reason: "account_unavailable",
    });
  });
});

describe("a removed account leaves the budget", () => {
  // Synthetic example IBANs (valid checksums, no real accounts).
  const PRIVATE = "PL61109010140000071219812874";
  const BUSINESS = "PL27114020040000300201355387";

  function household() {
    const store = openTestStore();
    const env = testEnv();
    run(store, env, createProfile, {
      slug: "synthetic-removal",
      name: "Synthetic",
      baseCurrency: "PLN",
      modules: ["budget"],
    });
    const seed = (
      iban: string,
      rows: { date: string; amount: string; name: string; iban?: string }[],
    ) => {
      const out = run(store, env, importStatement, {
        statement: {
          bank: "mbank",
          accountNumber: iban,
          accountName: `Synthetic ${iban.slice(-4)}`,
          currency: "PLN",
          balances: [],
          closingBalances: [],
          transactions: rows.map((row) => ({
            bookingDate: row.date,
            valueDate: null,
            amount: D(row.amount),
            currency: "PLN",
            counterpartyName: row.name,
            counterpartyIban: row.iban ?? null,
            description: row.name,
            reference: row.name,
            bankTransactionId: null,
            source: "csv" as const,
            raw: {},
          })),
        },
        newestDayRule: false,
      });
      if (!out.ok) throw new Error(`synthetic import refused: ${out.reason}`);
      return out.value.account;
    };
    const business = seed(BUSINESS, [
      { date: "2026-10-02", amount: "12300.00", name: "SYNTHETIC CLIENT" },
      { date: "2026-10-05", amount: "-2300.00", name: "SYNTHETIC VAT OFFICE" },
      { date: "2026-10-10", amount: "-5000.00", name: "SYNTHETIC OWNER", iban: PRIVATE },
    ]);
    seed(PRIVATE, [
      { date: "2026-10-10", amount: "5000.00", name: "SYNTHETIC OWNER", iban: BUSINESS },
      { date: "2026-10-12", amount: "-80.00", name: "SYNTHETIC GROCER" },
    ]);
    return { store, env, business };
  }

  const totals = (store: Store) => {
    const book = budgetBook(read(store));
    const [october] = budget.monthlyCashflow(book);
    return {
      rows: book.transactions.length,
      income: october?.income.toString() ?? null,
      expense: october?.expense.toString() ?? null,
      spending: budget.spendingByCategory(book).map((r) => r.amount.toString()),
    };
  };

  it("drops its rows from the book and keeps the live side of a draw an own transfer", () => {
    const { store, env, business } = household();
    expect(totals(store)).toMatchObject({ rows: 5, income: "12300.00", expense: "2380.00" });
    expect(run(store, env, removeBankAccount, { account: business }).ok).toBe(true);
    const after = totals(store);
    expect(after).toEqual({
      rows: 2,
      income: "0.00", // the draw from the removed account is not income
      expense: "80.00",
      spending: ["80.00"],
    });
    // The removed account stays in the book's accounts, so its IBAN is still an own IBAN.
    expect(budgetBook(read(store)).accounts.find((a) => a.id === business)?.removedAt).not.toBe(
      null,
    );
    expect(run(store, env, restoreBankAccount, { account: business }).ok).toBe(true);
    expect(totals(store)).toMatchObject({ rows: 5, income: "12300.00", expense: "2380.00" });
  });
});
