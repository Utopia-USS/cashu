// Explicit-profile and pre-effect boundaries, with genuine host stores and queued event writes.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { connectHost } from "@cashu/node-host";
import { budgetBook } from "@cashu/store/budget/queries";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import type { CommandIo } from "../tree.js";
import { runImportCommand } from "./importCommands.js";

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
afterEach(cleanup);
function commandIo(cwd: string): CommandIo {
  return {
    cwd,
    env: {},
    t: createTranslator("en"),
    tty: { stdin: false, stdout: false, stderr: false },
    signal: new AbortController().signal,
    stdout() {},
    stderr() {},
    prompt: async () => {
      throw new Error("unexpected prompt");
    },
    stdin: () => {
      throw new Error("unexpected stdin");
    },
  };
}
it("refuses unsupported selection, later-file representation and abort before any append", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const cwd = tempDir();
  mkdirSync(join(cwd, "in"));
  copyFileSync(
    join(ROOT, "connectors/mbank-csv/fixtures/mbank-zestawienie.csv"),
    join(cwd, "in/a.csv"),
  );
  writeFileSync(join(cwd, "in/z[red].csv"), "bad\n");
  const io = commandIo(cwd);
  const deps = { stores: host.stores, now: Date.now };
  const delegate = { kind: "unhandled" };
  try {
    expect(await runImportCommand(false, ["in/a.csv"], io, {}, deps)).toEqual(delegate);
    expect(await runImportCommand(false, ["in/a.csv"], io, { profile: "missing" }, deps)).toEqual(
      delegate,
    );
    for (const args of [
      ["--help"],
      ["in/a.csv", "--bank=MBANK"],
      ["in/a.csv", "--account-type=invalid"],
      ["in/a.csv", "--name=[red]markup[/]"],
      ["in/a.csv", "--unknown"],
    ])
      expect(await runImportCommand(false, args, io, { profile: "demo" }, deps)).toEqual(delegate);
    expect(await runImportCommand(true, ["in"], io, { profile: "demo" }, deps)).toEqual(delegate);
    const controller = new AbortController();
    controller.abort();
    expect(
      await runImportCommand(
        false,
        ["in/a.csv"],
        { ...io, signal: controller.signal },
        { profile: "demo" },
        deps,
      ),
    ).toBe(130);
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(budgetBook(vault.store.read.bind(vault.store)).transactions).toHaveLength(0);
    expect(vault.store.read("SELECT * FROM import_batches")).toHaveLength(0);
  } finally {
    await host.stop();
  }
});

it("executes root and budget aliases over the native host socket", async () => {
  const dir = tempDir();
  copyFileSync(
    join(ROOT, "connectors/mbank-csv/fixtures/mbank-zestawienie.csv"),
    join(dir, "statement.csv"),
  );
  const host = await startLocalHost({ ...testHostOptions(dir), launcher: false });
  const conn = await connectHost({ dataDir: dir, role: "cli", build: "test" });
  try {
    for (const leaf of [["import-csv"], ["budget", "import-csv"]]) {
      const result = await conn.call("cli.exec", {
        argv: ["-p", "demo", ...leaf, "statement.csv", "--bank=mbank"],
        cwd: dir,
        env: { CASHU_LANG: "en" },
        tty: { stdin: false, stdout: false, stderr: false },
      });
      expect(result).toEqual({ kind: "exit", code: 0 });
    }
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("missing synthetic vault");
    expect(vault.store.read("SELECT * FROM import_batches")).toHaveLength(2);
    expect(budgetBook(vault.store.read.bind(vault.store)).transactions.length > 0).toBe(true);
  } finally {
    conn.close();
    await host.stop();
  }
});

it("stops a directory import after a completed file when its vault selection changes", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  const cwd = tempDir();
  mkdirSync(join(cwd, "in"));
  const fixture = join(ROOT, "connectors/mbank-csv/fixtures/mbank-zestawienie.csv");
  copyFileSync(fixture, join(cwd, "in/a.csv"));
  copyFileSync(fixture, join(cwd, "in/b.csv"));
  const vault = [...host.stores.vaults.values()][0];
  if (!vault) throw new Error("missing synthetic vault");
  const vaults = host.stores.vaults as Map<string, typeof vault>;
  const stderr: string[] = [];
  let outputCount = 0;
  const io: CommandIo = {
    ...commandIo(cwd),
    stdout() {
      outputCount += 1;
      if (outputCount === 1) vaults.set(vault.id, { ...vault });
    },
    stderr: (line) => stderr.push(line),
  };
  try {
    expect(
      await runImportCommand(
        true,
        ["in", "--bank=mbank"],
        io,
        { profile: "demo" },
        {
          stores: host.stores,
          now: Date.now,
        },
      ),
    ).toBe(1);
    expect(outputCount).toBe(1);
    expect(stderr).toEqual(["Import stopped (vault_changed). Completed earlier imports: 1.\n"]);
    expect(vault.store.read("SELECT COUNT(*) AS n FROM import_batches")).toEqual([{ n: 1 }]);
  } finally {
    vaults.set(vault.id, vault);
    await host.stop();
  }
});
