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
    expect(await runTree(["-p", "demo", "budget", "cushion", "--off"], io(out), commands)).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(out.join("")).toBe("Cushion rule: off\n");
    const settings = budgetCliSettings(vault.store.read.bind(vault.store));
    expect(settings?.cushion.enabled).toBe(false);
    expect(settings?.cushion.accountIds).toEqual([account.value.account]);
    out.length = 0;
    expect(await runTree(["-p", "demo", "budget", "cushion"], io(out), commands)).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(out.join("")).toBe("Cushion rule: off\n");
  } finally {
    await host.stop();
  }
});

it("sets and reads selected native account gids only in the chosen vault", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  const other = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const vault = [...host.stores.vaults.values()][0];
    const otherVault = [...other.stores.vaults.values()][0];
    if (!vault || !otherVault) throw new Error("missing synthetic vault");
    const makeAccount = (selected: typeof vault, suffix: string) => {
      const result = runCommand(
        selected.store,
        selected.writer,
        openAccount,
        {
          bank: "mbank",
          type: "savings",
          currency: "PLN",
          iban: `PL100000000000000000000000${suffix}`,
        },
        selected.env,
      );
      if (!result.ok) throw new Error("synthetic account refused");
      return result.value.account;
    };
    const first = makeAccount(vault, "07");
    const second = makeAccount(vault, "08");
    const foreign = makeAccount(otherVault, "09");
    const out: string[] = [];
    const commands = budgetCommands({ stores: host.stores, now: () => Date.now() });
    const call = (...args: string[]) =>
      runTree(["-p", "demo", "budget", "cushion", ...args], io(out), commands);

    expect(await call("--target", "100", "--account", first, `--account=${second}`)).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(budgetCliSettings(vault.store.read.bind(vault.store))?.cushion.accountIds).toEqual([
      first,
      second,
    ]);
    expect(out.join("").replace(/\s+/g, " ")).toContain(`accounts [${first}, ${second}]`);
    out.length = 0;
    expect(await call()).toEqual({ kind: "exit", code: 0 });
    expect(out.join("").replace(/\s+/g, " ")).toContain(`accounts [${first}, ${second}]`);

    for (const gid of ["12", foreign]) {
      out.length = 0;
      expect((await call("--account", gid)).code).not.toBe(0);
      expect(budgetCliSettings(vault.store.read.bind(vault.store))?.cushion.accountIds).toEqual([
        first,
        second,
      ]);
    }
  } finally {
    await other.stop();
    await host.stop();
  }
});

it("does not append a queued cash expense after its loaded vault is replaced", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
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
    );
    vaults.set(vault.id, { ...vault });
    expect(await pending).toEqual({ kind: "exit", code: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("session_unavailable");
    expect(vault.store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 0 }]);
    vaults.set(vault.id, vault);
  } finally {
    await host.stop();
  }
});
