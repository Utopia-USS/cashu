import { createTranslator } from "@cashu/i18n";
import { openAccount, runCommand } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { assetCommands } from "../assets/index.js";
import { type CommandIo, runTree } from "../tree.js";
import { loansCommands } from "./index.js";

afterEach(cleanup);

function output() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env: {},
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin: () => {
      throw new Error("unexpected stdin");
    },
  };
  return { io, stdout, stderr };
}

it("uses native commands only in the selected vault and writes loans and assets through commands", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const deps = {
      stores: host.stores,
      now: () => new Date(2026, 9, 31, 12).getTime(),
      render: (text: string, io: CommandIo) => io.stdout(`${text}\n`),
    };
    const commands = [...assetCommands(deps), ...loansCommands(deps)];
    const { io, stdout, stderr } = output();
    const run = (args: string[]) => runTree(args, io, commands);
    expect(
      await run(["add-position", "Synthetic flat", "--type", "property", "--value", "250000"]),
    ).toEqual({ kind: "exit", code: 2 });
    expect(
      await run([
        "-p",
        "other",
        "loans",
        "add",
        "Synthetic debt",
        "--principal",
        "1000",
        "--rate",
        "5",
      ]),
    ).toEqual({ kind: "exit", code: 2 });
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(vault.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 0 }]);
    expect(
      await run([
        "-p",
        "demo",
        "add-position",
        "Synthetic flat",
        "--type",
        "property",
        "--value",
        "250000",
      ]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(
      await run([
        "-p",
        "demo",
        "loans",
        "add",
        "Synthetic debt",
        "--principal",
        "1000",
        "--rate",
        "5",
      ]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(
      await run([
        "-p",
        "demo",
        "loans",
        "add",
        "--account",
        "Synthetic debt",
        "--principal",
        "1100",
        "--rate",
        "5",
      ]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(vault.store.read("SELECT principal FROM loans")).toEqual([{ principal: "1100.0" }]);
    const account = vault.store.read<{ gid: string }>(
      "SELECT gid FROM accounts WHERE name = 'Synthetic debt'",
    )[0];
    if (!account) throw new Error("missing synthetic loan account");
    expect(await run(["-p", "demo", "loans", "set-loan", account.gid, "1200", "5"])).toEqual({
      kind: "exit",
      code: 0,
    });
    expect(vault.store.read("SELECT principal FROM loans")).toEqual([{ principal: "1200.0" }]);
    const loan = vault.store.read<{ gid: string }>("SELECT gid FROM loans")[0];
    if (!loan) throw new Error("missing synthetic loan");
    expect(
      await run([
        "-p",
        "demo",
        "loans",
        "set-payment",
        loan.gid,
        "--text",
        "synthetic installment",
      ]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(
      await run(["-p", "demo", "loans", "set-balance", loan.gid, "900", "--date", "2026-10-31"]),
    ).toEqual({ kind: "exit", code: 0 });
    expect(await run(["-p", "demo", "loans", "list"])).toEqual({ kind: "exit", code: 0 });
    expect(vault.store.read("SELECT COUNT(*) AS n FROM balances")).toEqual([{ n: 2 }]);
    const flat = vault.store.read<{ gid: string }>(
      "SELECT gid FROM accounts WHERE name = 'Synthetic flat'",
    )[0];
    expect(flat).toBeDefined();
    expect(stdout.some((line) => line.includes(`Position ${flat?.gid}`))).toBe(true);
    expect(stdout.some((line) => line.includes(`Loan GID ${loan.gid}`))).toBe(true);
    expect(stderr).toHaveLength(2);
  } finally {
    await host.stop();
  }
});

it("rejects malformed and unsupported native arguments without delegation or writes", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const deps = { stores: host.stores, now: Date.now, render: () => {} };
    const { io, stderr } = output();
    for (const args of [
      ["-p", "demo", "loans", "add", "Synthetic", "--principal", "bad", "--rate", "2"],
      ["-p", "demo", "loans", "set-payment", "bogus"],
      ["-p", "demo", "loans", "add", "--account", "missing", "--principal", "100", "--rate", "2"],
      ["-p", "demo", "add-position", "Synthetic", "--type", "property"],
      ["-p", "demo", "loans", "--help"],
    ])
      expect(await runTree(args, io, [...assetCommands(deps), ...loansCommands(deps)])).toEqual(
        { kind: "exit", code: 2 },
      );
    expect(
      await runTree(
        ["-p", "demo", "loans", "--help"],
        { ...io, t: createTranslator("pl") },
        [...assetCommands(deps), ...loansCommands(deps)]),
    ).toEqual({ kind: "exit", code: 2 });
    expect(stderr.some((line) => line.includes("Użycie: cashu loans"))).toBe(true);
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM accounts")).toEqual([{ n: 0 }]);
  } finally {
    await host.stop();
  }
});

it("refuses ambiguous exact loan account names before a loan append", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    for (const externalId of ["synthetic:first", "synthetic:second"]) {
      const outcome = runCommand(
        vault.store,
        vault.writer,
        openAccount,
        { bank: "manual", name: "Same synthetic name", type: "loan", currency: "PLN", externalId },
        vault.env,
      );
      expect(outcome.ok).toBe(true);
    }
    const { io } = output();
    expect(
      await runTree(
        [
          "-p",
          "demo",
          "loans",
          "add",
          "--account",
          "Same synthetic name",
          "--principal",
          "1000",
          "--rate",
          "5",
        ],
        io,
        loansCommands({ stores: host.stores, now: Date.now })),
    ).toEqual({ kind: "exit", code: 2 });
    expect(vault.store.read("SELECT COUNT(*) AS n FROM loans")).toEqual([{ n: 0 }]);
  } finally {
    await host.stop();
  }
});
