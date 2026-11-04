import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { runCommand, setModules } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(REPO, ".venv", "bin", "python");
afterEach(cleanup);

it.skipIf(!existsSync(PYTHON))(
  "matches Python investment month-close for strategy file states",
  async () => {
    const home = tempDir();
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CASHU_TESTING: "1",
      CASHU_DATA_DIR: tempDir(),
      CASHU_WORKSPACES_DIR: tempDir(),
      CASHU_AUTO_DAILY: "0",
      PYTHONPATH: join(REPO, "src"),
      CASHU_LANG: "en",
      LANG: "en_US.UTF-8",
    };
    const runs = [
      { yaml: null, lang: "en", tty: false },
      { yaml: "version: [\n", lang: "en", tty: false },
      { yaml: "version: 1\nbase_currency: PLN\n", lang: "en", tty: false },
      {
        yaml: "version: 1\nbase_currency: PLN\ncontributions:\n  monthly_amount: 2000\n  day_of_month: 10\n",
        lang: "pl",
        tty: true,
      },
      {
        yaml: 'version: 1\nbase_currency: PLN\ncontributions:\n  monthly_amount: "9007199254740993.01"\n  day_of_month: 10\n',
        lang: "en",
        tty: false,
      },
    ] as const;
    const oracle = spawnSync(
      PYTHON,
      [join(REPO, "apps/host/test-fixtures/budget-cash-oracle.py")],
      {
        cwd: REPO,
        env,
        encoding: "utf8",
        input: JSON.stringify({
          modules: ["budget", "investments"],
          cases: runs.map((run) => ({
            args: ["-p", "demo", "budget", "month-close", "--month", "2026-10"],
            env: {
              ...env,
              CASHU_LANG: run.lang,
              ...(run.tty ? { FORCE_COLOR: "1", COLUMNS: "120" } : {}),
            },
            strategy_yaml: run.yaml,
          })),
        }),
      },
    );
    expect(oracle.status, oracle.stderr).toBe(0);
    const expected = JSON.parse(oracle.stdout) as {
      code: number;
      stdout: string;
      stderr: string;
    }[];
    expect(expected[3]?.stdout.includes("Planned contribution")).toBe(true);
    expect(expected[4]?.stdout.includes("Planned contribution")).toBe(true);
    expect(expected[4]?.stdout).not.toBe(expected[3]?.stdout);
    const host = await startLocalHost({
      ...testHostOptions(tempDir()),
      launcher: false,
    });
    try {
      const vault = [...host.stores.vaults.values()][0];
      if (!vault) throw new Error("missing synthetic vault");
      expect(
        runCommand(
          vault.store,
          vault.writer,
          setModules,
          { moduleIds: ["budget", "investments"] },
          vault.env,
        ).ok,
      ).toBe(true);
      const unsupportedOutput: string[] = [];
      const withoutFiles: CommandIo = {
        cwd: home,
        env,
        tty: { stdin: false, stdout: false, stderr: false },
        signal: new AbortController().signal,
        t: createTranslator("en"),
        stdout: (text) => unsupportedOutput.push(text),
        stderr: (text) => unsupportedOutput.push(text),
        prompt: async () => null,
        stdin: async function* () {},
      };
      expect(
        await runTree(
          ["-p", "demo", "budget", "month-close", "--month", "2026-10"],
          withoutFiles,
          budgetCommands({ stores: host.stores, now: () => Date.now() })),
      ).toEqual({ kind: "exit", code: 2 });
      expect(unsupportedOutput).toHaveLength(1);
      let yaml: string | null = null;
      const commands = budgetCommands({
        stores: host.stores,
        now: () => Date.now(),
        strategyFiles: () => ({
          read: async (name) => (name === "strategy.yaml" ? yaml : null),
          write: async () => {
            throw new Error("unexpected strategy write");
          },
          exists: async (name) => name === "strategy.yaml" && yaml !== null,
        }),
      });
      for (const [index, run] of runs.entries()) {
        yaml = run.yaml;
        const actual = { code: -1, stdout: "", stderr: "" };
        const io: CommandIo = {
          cwd: home,
          env: {
            ...env,
            CASHU_LANG: run.lang,
            ...(run.tty ? { FORCE_COLOR: "1", COLUMNS: "120" } : {}),
          },
          tty: { stdin: false, stdout: run.tty, stderr: false },
          signal: new AbortController().signal,
          t: createTranslator(run.lang),
          stdout: (text) => {
            actual.stdout += text;
          },
          stderr: (text) => {
            actual.stderr += text;
          },
          prompt: async () => {
            throw new Error("unexpected prompt");
          },
          stdin: () => {
            throw new Error("unexpected stdin");
          },
        };
        const result = await runTree(
          ["-p", "demo", "budget", "month-close", "--month", "2026-10"],
          io,
          commands);
        expect(result, `strategy state ${index}`).toEqual({ kind: "exit", code: 0 });
        if (result.kind === "exit") actual.code = result.code;
        expect(actual, `Python strategy byte case ${index}`).toEqual(expected[index]);
      }
    } finally {
      await host.stop();
    }
  },
);
