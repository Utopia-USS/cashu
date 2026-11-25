import { createTranslator } from "@cashu/i18n";
import { addCashExpenseCli } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../host.js";
import { cleanup, tempDir, testHostOptions } from "../testing/harness.js";
import { cliCommandKey, runCliVaultCommand } from "./commandOutcome.js";
import { commandStatusCommand } from "./commandStatus.js";
import type { CommandIo } from "./tree.js";

afterEach(cleanup);

it("looks up the original CLI key without rerunning the financial command or printing its receipt", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  const key = cliCommandKey();
  const lines: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (text) => lines.push(text),
    stderr: (text) => lines.push(text),
    prompt: async () => null,
    stdin: async function* () {},
  };
  try {
    const status = commandStatusCommand(host.stores);
    expect(
      await status.run([addCashExpenseCli.id, `8${key.slice(1)}`], io, { profile: "demo" }),
    ).toEqual({ kind: "unhandled" });
    expect(await status.run([addCashExpenseCli.id, key], io, { profile: "demo" })).toBe(1);
    expect(lines.pop()).toBe(`outcome_unknown: ${addCashExpenseCli.id} ${key}\n`);
    const result = await runCliVaultCommand(
      vault,
      addCashExpenseCli,
      {
        amount: "1",
        title: "Synthetic",
        category: "dining",
        currency: "PLN",
        onDate: "2026-10-31",
      },
      key,
    );
    expect(result.kind).toBe("completed");
    const before = vault.store.read("SELECT COUNT(*) AS n FROM transactions");
    expect(await status.run([addCashExpenseCli.id, key], io, { profile: "demo" })).toBe(0);
    expect(lines).toEqual([`completed: ${addCashExpenseCli.id} ${key}\n`]);
    expect(vault.store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual(before);
  } finally {
    await host.stop();
  }
});
