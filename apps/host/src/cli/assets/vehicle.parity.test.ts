// Native command/store/renderer versus the bytes the retired Python CLI printed for the same runs
// (fixtures/vehicle.json, recorded with the date fixed at 2026-10-31), synthetic data only.
import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { printConsole } from "../core/console.js";
import { type CommandIo, runTree } from "../tree.js";
import expected from "./fixtures/vehicle.json" with { type: "json" };
import { vehicleCommands } from "./vehicle.js";

afterEach(cleanup);

it("matches the frozen Python success bytes for aliases, updates, Unicode, floors and Rich rendering", async () => {
  const home = tempDir();
  const runs: { args: string[]; env: Record<string, string> }[] = [
    {
      args: [
        "--profile",
        "demo",
        "set-vehicle",
        "Synthetic car",
        "80000",
        "2025-05-01",
        "--currency",
        "USD",
      ],
      env: {},
    },
    {
      args: [
        "-p",
        "demo",
        "assets",
        "set-vehicle",
        "Synthetic car",
        "90000",
        "20261031",
        "--rate=0",
        "--floor=0",
        "--currency=pln",
      ],
      env: { FORCE_COLOR: "1", COLUMNS: "47" },
    },
    {
      args: [
        "--profile=demo",
        "set-vehicle",
        "Łódź 表🙂",
        "１_０００.５",
        "2026W441",
        "--floor=900",
      ],
      env: { FORCE_COLOR: "1", COLUMNS: "31" },
    },
    {
      args: ["-p", "demo", "assets", "set-vehicle", "Future", "10", "2027-01-01", "--floor=2"],
      env: { FORCE_COLOR: "1", NO_COLOR: "1", COLUMNS: "120" },
    },
    {
      args: ["-p", "demo", "set-vehicle", "", "1e3", "2026-10-31", "--rate=100", "--floor=-0"],
      env: { COLUMNS: "19" },
    },
    {
      args: ["-p", "demo", "set-vehicle", "--rate=-1", "--", "Negative", "-1", "2026-10-31"],
      env: { FORCE_COLOR: "1", TERM: "dumb", COLUMNS: "18" },
    },
  ];
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
  });
  try {
    const commands = vehicleCommands({
      stores: host.stores,
      now: () => new Date(2026, 9, 31, 12).getTime(),
      render: (text, io) =>
        printConsole(io, text, { spans: [{ start: 0, end: 7, style: { color: 32 } }] }),
    });
    for (const [index, run] of runs.entries()) {
      const actual = { code: -1, stdout: "", stderr: "" };
      const io: CommandIo = {
        cwd: home,
        env: run.env,
        tty: { stdin: false, stdout: false, stderr: false },
        signal: new AbortController().signal,
        t: createTranslator("en"),
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
      expect(outcome, `native case ${index}`).toEqual({ kind: "exit", code: 0 });
      if (outcome.kind === "exit") actual.code = outcome.code;
      expect(actual, `Python byte case ${index}`).toEqual(expected[index]);
    }
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM depreciations")).toEqual([{ n: 5 }]);
  } finally {
    await host.stop();
  }
});
