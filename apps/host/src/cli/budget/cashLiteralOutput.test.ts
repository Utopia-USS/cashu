import { createTranslator } from "@cashu/i18n";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

afterEach(cleanup);

it("reads cash after adding a title with literal brackets and an emoji alias", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const commands = budgetCommands({ stores: host.stores, now: () => Date.now() });
    const output: string[] = [];
    const io: CommandIo = {
      cwd: tempDir(),
      env: { HOME: tempDir(), CASHU_LANG: "en", COLUMNS: "120" },
      tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
      signal: new AbortController().signal,
      t: createTranslator("en"),
      stdout: (text) => output.push(text),
      stderr: (text) => {
        throw new Error(`unexpected stderr: ${text}`);
      },
      prompt: async () => null,
      stdin: async function* () {},
    };
    const title = "[red]Lunch[/] :money_bag:";
    expect(
      await runTree(
        ["-p", "demo", "cash-add", "12.34", title, "dining", "--date", "2026-10-31"],
        io,
        commands,
      ),
    ).toEqual({ kind: "exit", code: 0 });
    output.length = 0;
    expect(await runTree(["-p", "demo", "cash"], io, commands)).toEqual({
      kind: "exit",
      code: 0,
    });
    const read = output.join("");
    expect(read).toContain(title);
    expect(read).toContain("Cash: -12,34 PLN");
    expect(read).toContain("-12,34 PLN");
  } finally {
    await host.stop();
  }
});
