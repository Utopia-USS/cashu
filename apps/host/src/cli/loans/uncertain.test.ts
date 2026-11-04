import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it, vi } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { loansCommands } from "./index.js";

const runDurable = vi.hoisted(() => vi.fn());
vi.mock("../commandOutcome.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../commandOutcome.js")>();
  return { ...real, runCliVaultCommand: runDurable };
});

afterEach(() => {
  runDurable.mockReset();
  cleanup();
});

it("reports a durable unknown outcome once and does not replay the loan write", async () => {
  const host = await startLocalHost({
    ...testHostOptions(tempDir()),
    launcher: false,
    python: null,
  });
  try {
    runDurable.mockImplementation(async (_vault, _command, _input, key) => ({
      kind: "outcome_unknown",
      key,
    }));
    const stderr: string[] = [];
    const io: CommandIo = {
      cwd: tempDir(),
      env: {},
      tty: { stdin: false, stdout: false, stderr: false },
      signal: new AbortController().signal,
      t: createTranslator("en"),
      stdout: () => {},
      stderr: (text) => stderr.push(text),
      prompt: async () => null,
      stdin: async function* () {},
    };
    const result = await runTree(
      ["-p", "demo", "loans", "add", "Synthetic debt", "--principal", "1000", "--rate", "5"],
      io,
      loansCommands({ stores: host.stores, now: Date.now }),
      {},
    );
    expect(result).toEqual({ kind: "exit", code: 1 });
    expect(runDurable).toHaveBeenCalledTimes(1);
    expect(stderr.join("")).toContain(
      "Command outcome unknown. Check: cashu command-status loans.addLoan",
    );
    const vault = [...host.stores.vaults.values()][0];
    expect(vault?.store.read("SELECT COUNT(*) AS n FROM loans")).toEqual([{ n: 0 }]);
  } finally {
    await host.stop();
  }
});
