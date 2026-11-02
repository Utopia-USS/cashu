// Source counts include skipped claims and cash rows; owner rule effects use real materializers.
import { type budget, D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import {
  addCashExpense,
  importStatement,
  runCommand,
  setLlmCategories,
  setTransactionCategory,
} from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runCategorizeCommand } from "./categorizeCommands.js";

afterEach(cleanup);
it("counts all rows, preserves manual/cash/LLM claims and pins only the eligible merchant rows", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
    python: null,
  });
  let stdout = "";
  const io: CommandIo = {
    cwd: tempDir(),
    env: {},
    t: createTranslator("en"),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    stdout: (text) => {
      stdout += text;
    },
    stderr() {},
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin: () => {
      throw new Error("unexpected stdin");
    },
  };
  const deps = { stores: host.stores, now: Date.now };
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const rows: budget.RawTransaction[] = ["a", "b", "c"].map((id) => ({
      bookingDate: "2026-09-01",
      valueDate: null,
      amount: D("-10"),
      currency: "PLN",
      counterpartyName: "UNKNOWN SHOP",
      counterpartyIban: null,
      description: id,
      reference: null,
      bankTransactionId: id,
      source: "csv",
      raw: {},
    }));
    const run = <I, R>(command: import("@cashu/store").Command<I, R>, input: unknown) => {
      const result = runCommand(vault.store, vault.writer, command, input, vault.env);
      expect(result.ok).toBe(true);
    };
    run(importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: null,
        accountName: "Synthetic",
        currency: "PLN",
        transactions: rows,
        balances: [],
        closingBalances: [],
      },
    });
    const book = () => budgetBook(vault.store.read.bind(vault.store));
    const first = book().transactions[0]?.key,
      second = book().transactions[1]?.key;
    run(setTransactionCategory, { txn: first, category: "travel" });
    run(setLlmCategories, { items: [{ txn: second, category: "dining" }] });
    run(addCashExpense, {
      amount: "2",
      title: "Cash gift",
      category: "gifts",
      onDate: "2026-09-01",
    });
    const claims = book().transactions.map((t) => [t.category, t.categorySource]);
    expect(await runCategorizeCommand("categorize", [], io, { profile: "demo" }, deps)).toBe(0);
    expect(stdout).toBe("Categorized 4 transactions.\n");
    expect(book().transactions.map((t) => [t.category, t.categorySource])).toEqual(claims);
    stdout = "";
    expect(
      await runCategorizeCommand("categorize", ["--llm"], io, { profile: "demo" }, deps),
    ).toEqual({ kind: "delegate" });
    expect(stdout).toBe("");
    expect(
      await runCategorizeCommand(
        "set-category",
        ["unknown shop", "groceries"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(0);
    expect(stdout).toBe("UNKNOWN SHOP → groceries (2 transactions)\n");
    expect(book().transactions[0]).toMatchObject({
      category: "travel",
      categorySource: "manual_txn",
    });
    expect(
      book()
        .transactions.slice(1, 3)
        .map((t) => [t.category, t.categorySource]),
    ).toEqual([
      ["groceries", "manual"],
      ["groceries", "manual"],
    ]);
    stdout = "";
    expect(await runCategorizeCommand("categorize", ["--llm"], io, { profile: "demo" }, deps)).toBe(
      0,
    );
    expect(stdout).toBe(
      "Categorized 4 transactions.\n  LLM: +0 rules (0 unknown expense merchants)\n",
    );
    stdout = "";
    expect(
      await runCategorizeCommand(
        "set-category",
        ["unknown shop", "cash_withdrawal"],
        io,
        { profile: "demo" },
        deps,
      ),
    ).toEqual({ kind: "delegate" });
    expect(await runCategorizeCommand("categorize", [], io, { profile: "other" }, deps)).toEqual({
      kind: "delegate",
    });
    expect(stdout).toBe("");
  } finally {
    await host.stop();
  }
});
