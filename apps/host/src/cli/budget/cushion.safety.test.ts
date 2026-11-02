import { createTranslator } from "@cashu/i18n";
import { openAccount, runCommand, setCushion } from "@cashu/store";
import { budgetCliSettings } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

afterEach(cleanup);

function io(output: string[], signal = new AbortController().signal): CommandIo {
  return {
    cwd: tempDir(),
    env: { CASHU_PROFILE: "demo", CASHU_LANG: "en" },
    tty: { stdin: false, stdout: false, stderr: false },
    signal,
    t: createTranslator("en"),
    stdout: (text) => output.push(text),
    stderr: (text) => output.push(text),
    prompt: async () => null,
    stdin: async function* () {},
  };
}

it("turns off and reads a cushion without discarding its selected account", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
    python: null,
  });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const account = runCommand(
      vault.store,
      vault.writer,
      openAccount,
      { bank: "mbank", type: "savings", currency: "PLN", iban: "PL10000000000000000000000006" },
      vault.env,
    );
    if (!account.ok) throw new Error("synthetic account refused");
    expect(
      runCommand(
        vault.store,
        vault.writer,
        setCushion,
        { enabled: true, targetAmount: "100", accounts: [account.value.account] },
        vault.env,
      ).ok,
    ).toBe(true);
    const out: string[] = [];
    const commands = budgetCommands({ stores: host.stores, now: () => Date.now() });
    expect(
      await runTree(["-p", "demo", "budget", "cushion", "--off"], io(out), commands, {}),
    ).toEqual({ kind: "exit", code: 0 });
    expect(out.join("")).toBe("Cushion rule: off\n");
    const settings = budgetCliSettings(vault.store.read.bind(vault.store));
    expect(settings?.cushion.enabled).toBe(false);
    expect(settings?.cushion.accountIds).toEqual([account.value.account]);
    out.length = 0;
    expect(await runTree(["-p", "demo", "budget", "cushion"], io(out), commands, {})).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(out.join("")).toBe("Cushion rule: off\n");
  } finally {
    await host.stop();
  }
});

it("does not append a queued cash expense after its loaded vault is replaced", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
    python: null,
  });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    const vaults = host.stores.vaults as Map<string, typeof vault>;
    const out: string[] = [];
    const pending = runTree(
      ["-p", "demo", "cash-add", "1", "Synthetic", "dining", "--date", "2026-10-31"],
      io(out),
      budgetCommands({ stores: host.stores, now: () => Date.now() }),
      {},
    );
    vaults.set(vault.id, { ...vault });
    expect(await pending).toEqual({ kind: "delegate" });
    expect(out).toEqual([]);
    expect(vault.store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 0 }]);
    vaults.set(vault.id, vault);
  } finally {
    await host.stop();
  }
});
