import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { D } from "@cashu/domain";
import { createTranslator } from "@cashu/i18n";
import { importStatement, learnMerchantCategory, renameProfile } from "@cashu/store";
import { expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { nativeVaultFixture } from "../testing/nativeVaultFixture.js";
import { cliCommandKey, reportCliCommandFailure, runCliVaultCommand } from "./commandOutcome.js";
import type { CommandIo } from "./tree.js";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["cancel", "profile-switch"])(
  "preserves the original key when CLI context changes after encrypted append: %s",
  async (change) => {
    const fixture = await nativeVaultFixture();
    const host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      vaultSource: fixture.vaultSource,
    });
    const gate = deferred();
    const wrote = deferred();
    try {
      const vault = host.stores.vaults.get(fixture.vaultId);
      if (!vault?.native) throw new Error("native vault missing");
      const original = vault.native.engine.write.bind(vault.native.engine);
      vault.native.engine.write = async (...args) => {
        const result = await original(...args);
        wrote.release();
        await gate.promise;
        return result;
      };
      let selected = true;
      const controller = new AbortController();
      const key = cliCommandKey();
      const work = runCliVaultCommand(
        vault,
        renameProfile,
        { name: "Synthetic updated" },
        key,
        () => selected && !controller.signal.aborted,
      );
      await wrote.promise;
      if (change === "cancel") controller.abort();
      else selected = false;
      gate.release();
      expect(await work).toMatchObject({ kind: "outcome_unknown", key });
    } finally {
      gate.release();
      await host.stop();
      fixture.cleanup();
    }
  },
);

it("reports an uncertain durable key in Polish", () => {
  const lines: string[] = [];
  const io: CommandIo = {
    cwd: realpathSync(tmpdir()),
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("pl"),
    stdout: () => {},
    stderr: (line) => {
      lines.push(line);
    },
    prompt: async () => null,
    stdin: async function* () {},
  };
  expect(
    reportCliCommandFailure(
      io,
      { kind: "outcome_unknown", key: "synthetic" },
      "synthetic",
      "loans.addLoan",
    ),
  ).toBe(1);
  expect(lines.join("")).toContain("Nie wiadomo, czy polecenie się udało");
  expect(lines.join("")).toContain("cashu command-status loans.addLoan synthetic");
});

it("reconciles the learned setter's original pair count after an uncertain encrypted append", async () => {
  const fixture = await nativeVaultFixture({ modules: ["budget"] });
  const host = await startLocalHost({
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  });
  const gate = deferred();
  const wrote = deferred();
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault?.native) throw new Error("native vault missing");
    const imported = await runCliVaultCommand(
      vault,
      importStatement,
      {
        statement: {
          bank: "mbank",
          accountNumber: null,
          accountName: "Synthetic",
          currency: "PLN",
          transactions: [
            {
              bookingDate: "2026-10-01",
              valueDate: null,
              amount: D("-10"),
              currency: "PLN",
              counterpartyName: "ZXQ DURABLE TEST",
              counterpartyIban: null,
              description: null,
              reference: null,
              bankTransactionId: "synthetic-1",
              source: "csv",
              raw: {},
            },
          ],
          balances: [],
          closingBalances: [],
        },
      },
      cliCommandKey(),
    );
    expect(imported.kind).toBe("completed");
    const firstKey = cliCommandKey();
    const firstInput = { merchantKey: "ZXQ DURABLE TEST", category: "dining" };
    const first = await runCliVaultCommand(vault, learnMerchantCategory, firstInput, firstKey);
    const replay = await runCliVaultCommand(vault, learnMerchantCategory, firstInput, firstKey);
    expect(first).toMatchObject({ kind: "completed", value: { updated: 1 } });
    expect(replay).toEqual(first);
    const original = vault.native.engine.write.bind(vault.native.engine);
    vault.native.engine.write = async (...args) => {
      const result = await original(...args);
      wrote.release();
      await gate.promise;
      return result;
    };
    let current = true;
    const key = cliCommandKey();
    const input = { merchantKey: "ZXQ DURABLE TEST", category: "shopping" };
    const pending = runCliVaultCommand(vault, learnMerchantCategory, input, key, () => current);
    await wrote.promise;
    current = false;
    gate.release();
    const unknown = await pending;
    expect(unknown).toMatchObject({ kind: "outcome_unknown", key });
    current = true;
    const retry = await runCliVaultCommand(vault, learnMerchantCategory, input, key, () => current);
    expect(retry).toEqual(unknown);
    expect(vault.store.read("SELECT * FROM category_rules")).toHaveLength(1);
  } finally {
    gate.release();
    await host.stop();
    fixture.cleanup();
  }
});
