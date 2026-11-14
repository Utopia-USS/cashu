// `cashu remove-account` / `cashu restore-account` on a synthetic vault.
import { createTranslator } from "@cashu/i18n";
import { openAccount } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { cliCommandKey, runCliVaultCommand } from "../commandOutcome.js";
import type { CommandIo } from "../tree.js";
import { accountCommands } from "./accounts.js";

afterEach(cleanup);

function output(env: Record<string, string> = { CASHU_PROFILE: "demo" }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env,
    tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { io, stdout, stderr };
}

it("removes a bank account from the accounts list and restores it", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const open = (name: string, type: string) =>
      runCliVaultCommand(
        vault,
        openAccount,
        { bank: "synthetic", name, type, currency: "PLN" },
        cliCommandKey(),
      );
    expect((await open("Closed account", "checking")).kind).toBe("completed");
    expect((await open("Wallet", "cash")).kind).toBe("completed");
    const gidOf = (name: string) =>
      vault.store.read<{ gid: string }>("SELECT gid FROM accounts WHERE name = ?", name)[0]?.gid;
    const bank = gidOf("Closed account");
    const cash = gidOf("Wallet");
    if (!bank || !cash) throw new Error("account gid missing");
    const deps = { stores: host.stores, now: () => new Date(2026, 10, 9).getTime() };
    const commands = new Map(accountCommands(deps).map((command) => [command.name, command]));
    const removed = output();
    expect(await commands.get("remove-account")?.run([bank], removed.io, {})).toBe(0);
    expect(removed.stdout.join("")).toContain(
      `Removed account ${bank} from view and from the budget`,
    );
    const listed = output();
    expect(await commands.get("accounts")?.run([], listed.io, {})).toBe(0);
    expect(listed.stdout.join("")).not.toContain("Closed account");
    const restored = output();
    expect(await commands.get("restore-account")?.run([bank], restored.io, {})).toBe(0);
    expect(restored.stdout.join("")).toContain(`Restored account ${bank}.`);
    const again = output();
    expect(await commands.get("accounts")?.run([], again.io, {})).toBe(0);
    expect(again.stdout.join("")).toContain("Closed account");

    const refused = output();
    expect(await commands.get("remove-account")?.run([cash], refused.io, {})).toBe(2);
    expect(refused.stderr.join("")).toContain("is not a bank account");
    const bad = output();
    expect(await commands.get("remove-account")?.run([], bad.io, {})).toBe(2);
    expect(bad.stderr.join("")).toContain("Usage: cashu remove-account ACCOUNT_GID");
  } finally {
    await host.stop();
  }
});
