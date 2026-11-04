// Native cash CLI bytes against the bytes the retired Python CLI printed for the same runs
// (fixtures/cash.json, recorded on 2026-11-05), and native append state over a synthetic profile.
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import expected from "./fixtures/cash.json" with { type: "json" };
import { budgetCommands } from "./index.js";

/** The day the fixture was recorded: the native clock is pinned to it. */
const RECORDED = new Date(2026, 10, 5, 12).getTime();
afterEach(cleanup);

it("matches the frozen Python cash CLI bytes and one-append state", async () => {
  const home = tempDir();
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
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const commands = budgetCommands({
      stores: host.stores,
      now: () => RECORDED,
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
