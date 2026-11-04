import { createTranslator } from "@cashu/i18n";
import { expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { nativeVaultFixture } from "../../testing/nativeVaultFixture.js";
import { assetCommands } from "../assets/index.js";
import { type CommandIo, runTree } from "../tree.js";
import { loansCommands } from "./index.js";

it("appends CLI loans and assets to an encrypted vault and reopens their projections", async () => {
  const fixture = await nativeVaultFixture({ modules: ["assets", "loans"] });
  const options = {
    dataDir: fixture.dataDir,
    home: fixture.home,
    build: "test",
    launcher: false,
    vaultSource: fixture.vaultSource,
  } as const;
  const io: CommandIo = {
    cwd: fixture.home,
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: () => {},
    stderr: (line) => {
      throw new Error(line);
    },
    prompt: async () => null,
    stdin: async function* () {},
  };
  const host = await startLocalHost(options);
  let reopened: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    const vault = host.stores.vaults.get(fixture.vaultId);
    expect(vault?.native).toBeDefined();
    const deps = {
      stores: host.stores,
      now: () => new Date(2026, 9, 31, 12).getTime(),
      render: () => {},
    };
    const commands = [...assetCommands(deps), ...loansCommands(deps)];
    expect(
      await runTree(
        [
          "-p",
          fixture.profileSlug,
          "add-position",
          "Synthetic home",
          "--type",
          "property",
          "--value",
          "50000",
        ],
        io,
        commands),
    ).toEqual({ kind: "exit", code: 0 });
    expect(
      await runTree(
        [
          "-p",
          fixture.profileSlug,
          "loans",
          "add",
          "Synthetic loan",
          "--principal",
          "2000",
          "--rate",
          "4",
        ],
        io,
        commands),
    ).toEqual({ kind: "exit", code: 0 });
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 2 }]);
    await host.stop();
    reopened = await startLocalHost(options);
    const reopenedVault = reopened.stores.vaults.get(fixture.vaultId);
    expect(reopenedVault?.native).toBeDefined();
    expect(reopenedVault?.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 2 }]);
    expect(reopenedVault?.store.read("SELECT COUNT(*) AS n FROM loans")).toEqual([{ n: 1 }]);
    expect(reopenedVault?.store.read("SELECT COUNT(*) AS n FROM balances")).toEqual([{ n: 1 }]);
  } finally {
    await reopened?.stop();
    await host.stop();
    fixture.cleanup();
  }
});
