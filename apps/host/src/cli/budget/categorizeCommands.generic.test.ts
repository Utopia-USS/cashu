// `set-category` on a bank's generic phrase: a specific message in both languages, a non-zero exit, no rule.
import { type budget, D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import { importStatement, runCommand, setModules } from "@cashu/store";
import { budgetBook } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runCategorizeCommand } from "./categorizeCommands.js";

afterEach(cleanup);

function captureIo(language: "pl" | "en") {
  const out = { stdout: "", stderr: "" };
  const io: CommandIo = {
    cwd: tempDir(),
    env: {},
    t: createTranslator(language),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin: () => {
      throw new Error("unexpected stdin");
    },
  };
  return { io, out };
}

it("refuses a rule on a generic bank phrase with a specific message and exit 1, writing nothing", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const deps = { stores: host.stores, now: Date.now };
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    // Two transfers with no counterparty and no title: their merchant key is the operation type.
    const rows: budget.RawTransaction[] = ["g1", "g2"].map((id) => ({
      bookingDate: "2026-09-01",
      valueDate: null,
      amount: D("-10"),
      currency: "PLN",
      counterpartyName: null,
      counterpartyIban: null,
      description: "PRZELEW",
      reference: null,
      bankTransactionId: id,
      source: "csv",
      raw: {},
    }));
    const run = <I, R>(command: import("@cashu/store").Command<I, R>, input: unknown) =>
      expect(runCommand(vault.store, vault.writer, command, input, vault.env).ok).toBe(true);
    run(setModules, { moduleIds: ["budget"] });
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
    const before = book().transactions.map((t) => [t.category, t.categorySource]);
    expect(before.length).toBe(2);

    const en = captureIo("en");
    expect(
      await runCategorizeCommand(
        "set-category",
        ["przelew", "groceries"],
        en.io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(1);
    expect(en.out.stdout).toBe("");
    expect(en.out.stderr).toBe(
      'No rule can be set for "PRZELEW": it is a generic bank phrase that covers payments to many different payees. Categorize the single payment in the app instead.\n',
    );

    const pl = captureIo("pl");
    expect(
      await runCategorizeCommand(
        "set-category",
        ["Przelew", "groceries"],
        pl.io,
        { profile: "demo" },
        deps,
      ),
    ).toBe(1);
    expect(pl.out.stderr).toBe(
      "Nie można ustawić reguły dla „PRZELEW”: to ogólna fraza banku, pod którą kryją się płatności dla różnych odbiorców. Zamiast tego przypisz kategorię pojedynczej płatności w aplikacji.\n",
    );

    expect(book().transactions.map((t) => [t.category, t.categorySource])).toEqual(before);
    expect(book().transactions.every((t) => t.categorySource !== "manual")).toBe(true);
  } finally {
    await host.stop();
  }
});
