// Actual Python CLI bytes and native append state over isolated synthetic profiles.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

const REPO = fileURLToPath(new URL("../../../../../", import.meta.url));
const PYTHON = join(REPO, ".venv", "bin", "python");
afterEach(cleanup);

it.skipIf(!existsSync(PYTHON))("matches Python cash CLI bytes and one-append state", async () => {
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
  const runs: { args: string[]; env: Record<string, string> }[] = [
    { args: ["-p", "demo", "cash"], env: {} },
    {
      args: ["-p", "demo", "cash-add", "2.345", "Lunch", "dining", "--date", "2026-10-31"],
      env: {},
    },
    { args: ["-p", "demo", "cash"], env: {} },
    { args: ["-p", "demo", "cash"], env: { FORCE_COLOR: "1", COLUMNS: "80" } },
    {
      args: [
        "-p",
        "demo",
        "budget",
        "cash-add",
        "--date",
        "2026-10-31",
        "--",
        "-0.1",
        "  Space  ",
        "dining",
      ],
      env: {},
    },
    { args: ["-p", "demo", "budget", "cash"], env: {} },
    { args: ["-p", "demo", "cash"], env: { FORCE_COLOR: "1", COLUMNS: "80" } },
    {
      args: ["-p", "demo", "cash-add", "0.01", "Future", "dining", "--date", "2026-10-01"],
      env: {},
    },
    { args: ["-p", "demo", "cash", "--currency", "EUR"], env: {} },
    { args: ["-p", "demo", "budget", "cushion"], env: {} },
    { args: ["-p", "demo", "budget", "cushion", "--target", "100"], env: {} },
    { args: ["-p", "demo", "budget", "month-close", "--month", "2026-09"], env: {} },
    { args: ["-p", "demo", "budget", "month-close", "--month=2026-09"], env: {} },
    { args: ["-p", "demo", "budget", "cushion", "--off"], env: {} },
    { args: ["-p", "demo", "budget", "month-close", "--month", "2026-10"], env: {} },
    {
      args: ["-p", "demo", "budget", "month-close", "--month", "2026-10"],
      env: { FORCE_COLOR: "1", COLUMNS: "120", CASHU_LANG: "pl" },
    },
    { args: ["-p", "demo", "budget", "cushion", "--target", "100", "--months", "3"], env: {} },
    { args: ["-p", "demo", "budget", "cushion", "--months", "2", "--target", "50"], env: {} },
    {
      args: ["-p", "demo", "cash-add", "-5", "Rejected", "dining", "--date", "2026-10-01"],
      env: {},
    },
  ];
  const oracle = spawnSync(PYTHON, [join(REPO, "apps/host/test-fixtures/budget-cash-oracle.py")], {
    cwd: REPO,
    env,
    encoding: "utf8",
    input: JSON.stringify(runs.map((r) => ({ args: r.args, env: { ...env, ...r.env } }))),
  });
  expect(oracle.status, oracle.stderr).toBe(0);
  const expected = JSON.parse(oracle.stdout) as { code: number; stdout: string; stderr: string }[];
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const commands = budgetCommands({
      stores: host.stores,
      now: () => Date.now(),
    });
    for (const [index, run] of runs.entries()) {
      const actual = { code: -1, stdout: "", stderr: "" };
      const io: CommandIo = {
        cwd: home,
        env: run.env,
        tty: { stdin: false, stdout: false, stderr: false },
        signal: new AbortController().signal,
        t: createTranslator(run.env.CASHU_LANG === "pl" ? "pl" : "en"),
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
      const outcome = await runTree(run.args, io, commands);
      if (index === runs.length - 1) {
        expect(expected[index]?.code).toBe(2);
        expect(outcome).toEqual({ kind: "exit", code: 2 });
        continue;
      }
      expect(outcome, `native cash case ${index}`).toEqual({ kind: "exit", code: 0 });
      if (outcome.kind === "exit") actual.code = outcome.code;
      expect(actual, `Python cash byte case ${index}`).toEqual(expected[index]);
    }
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM transactions")).toEqual([{ n: 3 }]);
  } finally {
    await host.stop();
  }
});
