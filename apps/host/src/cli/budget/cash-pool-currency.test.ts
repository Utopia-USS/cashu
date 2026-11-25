// `cashu cash` with a cash pool's rows in another currency (data-safety rule 5): the pool's line
// keeps only its own currency, the other currency is its own line named after the pool plus the
// currency code (as `cashu stats` and net worth name it). Synthetic data only. Hand-computed:
// PLN -12.00; EUR -3.00 - 5.00 = -8.00 (summing them gave the wrong -20.00 PLN).
import { createTranslator } from "@cashu/i18n";
import { HybridClock, mintUlid } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

afterEach(cleanup);

it("prints the pool in its own currency and the foreign part on its own line", async () => {
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
    expect(
      await runTree(
        ["-p", "demo", "cash-add", "12.00", "Synthetic coffee", "dining", "--date", "2026-10-20"],
        io,
        commands,
      ),
    ).toEqual({ kind: "exit", code: 0 });

    output.length = 0;
    expect(await runTree(["-p", "demo", "cash"], io, commands)).toEqual({ kind: "exit", code: 0 });
    const single = output.join("");
    expect(single).toContain("Cash: -12,00 PLN");
    expect(single).not.toContain("EUR");

    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const pool = vault.store.read<{ gid: string; name: string }>(
      "SELECT gid, name FROM accounts WHERE type = 'cash'",
    )[0];
    if (pool === undefined) throw new Error("missing the synthetic cash pool");
    const device = "d".repeat(32);
    const hlc = new HybridClock(device);
    let n = 0;
    const random = (size: number) => Uint8Array.from({ length: size }, () => (n++ * 41) & 0xff);
    const at = Date.parse("2026-10-26T12:00:00Z");
    const applied = vault.store.applyEnvelopes(
      [
        ["2026-10-10", "-3.00"],
        ["2026-10-25", "-5.00"],
      ].map(([bookingDate, amount]) => ({
        eid: mintUlid(at, random),
        vault: vault.id,
        device,
        hlc: hlc.tick(),
        at: new Date(at).toISOString(),
        type: "txn.cashExpenseAdded",
        v: 1,
        gid: mintUlid(at, random),
        data: {
          account: pool.gid,
          bookingDate,
          amount,
          currency: "EUR",
          title: "Synthetic euro coffee",
          category: "dining",
        },
      })),
    ).applied;
    expect(applied).toBe(2);

    output.length = 0;
    expect(await runTree(["-p", "demo", "cash"], io, commands)).toEqual({ kind: "exit", code: 0 });
    const text = output.join("");
    const lines = text.split("\n");
    expect(lines).toContain("Cash: -12,00 PLN");
    expect(lines).toContain(`${pool.name} (EUR): -8,00 EUR`);
    expect(text).not.toContain("-20,00");
    expect(text).toContain("-5,00 EUR");
    expect(text).toContain("-3,00 EUR");
  } finally {
    await host.stop();
  }
});
