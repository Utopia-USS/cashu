import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CliExecParams, HostFrame } from "@cashu/host-protocol";
import { createTranslator } from "@cashu/i18n";
import { connectHost } from "@cashu/node-host";
import { investmentsCommands, runCommand, setModules } from "@cashu/store";
import { PerformanceService } from "@cashu/store/investments/performance";
import { brokerageAccounts, importBatches } from "@cashu/store/investments/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { nativeVaultFixture } from "../../testing/nativeVaultFixture.js";
import { type CommandIo, runTree } from "../tree.js";
import { investmentCommands } from "./index.js";

afterEach(cleanup);

it("answers native investment commands over a real socket and refuses unavailable leaves", async () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "invalid.csv"), "synthetic,header\n");
  const dataDir = tempDir();
  const host = await startLocalHost({
    ...testHostOptions(dataDir),
    launcher: false,
    python: null,
  });
  const command = async (argv: string[]) => {
    const connection = await connectHost({ dataDir, role: "cli", build: "test" });
    try {
      const notes: { method: string; params: unknown }[] = [];
      const answer = new Promise<unknown>((resolve, reject) => {
        connection.onFrame((frame: HostFrame) => {
          if (frame.t === "note" && frame.id === 1)
            notes.push({ method: frame.method, params: frame.params });
          if (frame.t === "res" && frame.id === 1) {
            if (frame.outcome.ok) resolve(frame.outcome.result);
            else reject(new Error(frame.outcome.error.code));
          }
        });
      });
      const params: CliExecParams = {
        argv,
        cwd,
        env: { CASHU_LANG: "en" },
        tty: { stdin: false, stdout: false, stderr: false },
      };
      connection.send({ t: "req", id: 1, method: "cli.exec", params });
      return { result: await answer, notes };
    } finally {
      connection.close();
    }
  };
  try {
    const kinds = await command(["invest", "alerts", "kinds"]);
    expect(kinds.result).toEqual({ kind: "exit", code: 0 });
    expect(kinds.notes.some((note) => note.method === "cli.out")).toBe(true);
    const invalid = await command(["invest", "validate", "invalid.csv"]);
    expect(invalid.result).toEqual({ kind: "exit", code: 1 });
    expect(invalid.notes.some((note) => note.method === "cli.out")).toBe(true);
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(
      runCommand(vault.store, vault.writer, setModules, { moduleIds: ["investments"] }, vault.env)
        .ok,
    ).toBe(true);
    const added = await command([
      "-p",
      "demo",
      "invest",
      "accounts",
      "add",
      "Synthetic broker",
      "--broker",
      "xtb",
    ]);
    expect(added.result).toEqual({ kind: "exit", code: 0 });
    expect(added.notes.some((note) => note.method === "cli.out")).toBe(true);
    const listed = await command(["-p", "demo", "invest", "accounts", "list"]);
    expect(listed.result).toEqual({ kind: "exit", code: 0 });
    const unbound = await command(["-p", "demo", "invest", "run", "--offline"]);
    expect(unbound.result).toEqual({ kind: "exit", code: 1 });
    expect(unbound.notes.some((note) => note.method === "cli.out")).toBe(true);
    const source = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.createInstrument,
      {
        name: "Synthetic source",
        assetClass: "equity",
        currency: "PLN",
      },
      vault.env,
    );
    const target = runCommand(
      vault.store,
      vault.writer,
      investmentsCommands.createInstrument,
      {
        name: "Synthetic target",
        assetClass: "equity",
        currency: "PLN",
      },
      vault.env,
    );
    if (!source.ok || !target.ok) throw new Error("synthetic instruments absent");
    const preview = await command([
      "-p",
      "demo",
      "invest",
      "instruments",
      "merge",
      source.value.gid,
      target.value.gid,
      "--dry-run",
    ]);
    expect(preview.result).toEqual({ kind: "exit", code: 0 });
    const refusedMerge = await command([
      "-p",
      "demo",
      "invest",
      "instruments",
      "merge",
      source.value.gid,
      target.value.gid,
    ]);
    expect(refusedMerge.result).toEqual({ kind: "exit", code: 1 });
    expect(
      refusedMerge.notes.some((note) =>
        JSON.stringify(note.params).includes("encrypted vault checkpoint"),
      ),
    ).toBe(true);
  } finally {
    await host.stop();
  }
});

it("adds and reads a brokerage account through a genuine encrypted native host socket", async () => {
  const fixture = await nativeVaultFixture({ modules: ["investments"] });
  chmodSync(join(fixture.dataDir, "vaults"), 0o700);
  chmodSync(join(fixture.dataDir, "vaults", fixture.vaultId), 0o700);
  let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
  try {
    host = await startLocalHost({
      dataDir: fixture.dataDir,
      home: fixture.home,
      build: "test",
      launcher: false,
      python: null,
      vaultSource: fixture.vaultSource,
    });
    const execute = async (argv: string[]) => {
      const connection = await connectHost({
        dataDir: fixture.dataDir,
        role: "cli",
        build: "test",
      });
      try {
        const notes: string[] = [];
        const answer = new Promise<unknown>((resolve, reject) => {
          connection.onFrame((frame: HostFrame) => {
            if (frame.t === "note" && frame.id === 1 && frame.method === "cli.out")
              notes.push(JSON.stringify(frame.params));
            if (frame.t === "res" && frame.id === 1) {
              if (frame.outcome.ok) resolve(frame.outcome.result);
              else reject(new Error(frame.outcome.error.code));
            }
          });
        });
        connection.send({
          t: "req",
          id: 1,
          method: "cli.exec",
          params: {
            argv,
            cwd: tempDir(),
            env: { CASHU_LANG: "en" },
            tty: { stdin: false, stdout: false, stderr: false },
          } satisfies CliExecParams,
        });
        return { result: await answer, notes };
      } finally {
        connection.close();
      }
    };
    const prefix = ["-p", fixture.profileSlug, "invest"];
    const added = await execute([
      ...prefix,
      "accounts",
      "add",
      "Synthetic broker",
      "--broker",
      "xtb",
    ]);
    expect(added.result).toEqual({ kind: "exit", code: 0 });
    expect(added.notes.join(" ")).toContain("Brokerage account");
    const listed = await execute([...prefix, "accounts", "list"]);
    expect(listed.result).toEqual({ kind: "exit", code: 0 });
    expect(listed.notes.join(" ")).toContain("Brokerage accounts");
    const initialized = await execute([...prefix, "strategy", "init"]);
    expect(initialized.result).toEqual({ kind: "exit", code: 0 });
    expect(initialized.notes.join(" ")).toContain("strategy.yaml");
    const validated = await execute([...prefix, "strategy", "validate"]);
    expect(validated.result).toEqual({ kind: "exit", code: 0 });
    expect(validated.notes.join(" ")).toContain("strategy.yaml");
    const vault = host.stores.vaults.get(fixture.vaultId);
    if (!vault) throw new Error("missing native vault");
    const account = brokerageAccounts(vault.store.read.bind(vault.store))[0];
    if (!account) throw new Error("missing synthetic brokerage account");
    const importPath = join(fixture.dataDir, "synthetic-import.csv");
    writeFileSync(
      importPath,
      "format_version,record,date,type,currency,cash_amount\n1,txn,2026-01-05,deposit,PLN,5\n",
    );
    const preview = await execute([
      ...prefix,
      "import",
      importPath,
      "--account",
      account.gid,
      "--dry-run",
    ]);
    expect(preview.result).toEqual({ kind: "exit", code: 0 });
    expect(preview.notes.join(" ")).toContain("Dry run");
    const imported = await execute([...prefix, "import", importPath, "--account", account.gid]);
    expect(imported.result).toEqual({ kind: "exit", code: 0 });
    expect(imported.notes.join(" ")).toContain("Imported");
    expect(importBatches(vault.store.read.bind(vault.store))).toHaveLength(1);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredQueue = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = vault.queue.run(async () => {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await enteredQueue;
    const controller = new AbortController();
    const output: string[] = [];
    const io: CommandIo = {
      cwd: tempDir(),
      env: { CASHU_LANG: "en" },
      tty: { stdin: false, stdout: false, stderr: false },
      signal: controller.signal,
      t: createTranslator("en"),
      stdout: (text) => {
        output.push(text);
      },
      stderr: (text) => {
        output.push(text);
      },
      prompt: async () => null,
      stdin: async function* () {},
    };
    const count = brokerageAccounts(vault.store.read.bind(vault.store)).length;
    const attempt = runTree(
      [...prefix, "accounts", "add", "Cancelled account", "--broker", "xtb"],
      io,
      investmentCommands({
        stores: host.stores,
        now: Date.now,
        sources: {},
        performance: new PerformanceService(),
      }),
      {},
    );
    await expect.poll(() => vault.queue.pending).toBeGreaterThan(1);
    controller.abort();
    release?.();
    await held;
    await attempt;
    expect(brokerageAccounts(vault.store.read.bind(vault.store))).toHaveLength(count);
  } finally {
    await host?.stop();
    fixture.cleanup();
  }
});
