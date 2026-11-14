// `cashu stats` with a cash pool's rows in another currency (data-safety rule 5): the part is its
// own net-worth row in that currency, named after its pool plus the currency code, and the pool's
// currency total keeps only the pool's own rows. Synthetic data only. Hand-computed: PLN -12.00;
// EUR -3.00 - 5.00 = -8.00 (summing them gave the wrong -20.00 PLN; the CLI prints "-8,00 EUR").
import { createTranslator } from "@cashu/i18n";
import { addCashExpense, HybridClock, mintUlid } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { cliCommandKey, runCliVaultCommand } from "../commandOutcome.js";
import type { CommandIo } from "../tree.js";
import { statsCommand } from "./stats.js";

afterEach(cleanup);

function output() {
  const stdout: string[] = [];
  const io: CommandIo = {
    cwd: tempDir(),
    env: { CASHU_PROFILE: "demo" },
    tty: { stdin: false, stdout: false, stderr: false, columns: 200 },
    signal: new AbortController().signal,
    t: createTranslator("en"),
    stdout: (value) => stdout.push(value),
    stderr: () => {},
    prompt: async () => null,
    stdin: async function* () {},
  };
  return { io, stdout };
}

it("lists a pool's part in another currency as its own row named after the pool", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    const added = await runCliVaultCommand(
      vault,
      addCashExpense,
      { amount: "12.00", title: "Synthetic coffee", category: "dining", onDate: "2026-10-20" },
      cliCommandKey(),
    );
    expect(added.kind).toBe("completed");
    const pool = vault.store.read<{ gid: string; name: string }>(
      "SELECT gid, name FROM accounts WHERE type = 'cash'",
    )[0];
    if (pool === undefined) throw new Error("missing the synthetic cash pool");
    const device = "e".repeat(32);
    const hlc = new HybridClock(device);
    let n = 0;
    const random = (size: number) => Uint8Array.from({ length: size }, () => (n++ * 37) & 0xff);
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

    const out = output();
    const deps = { stores: host.stores, now: () => new Date(2026, 9, 31).getTime(), prices: null };
    expect(await statsCommand(deps).run([], out.io, {})).toBe(0);
    const text = out.stdout.join("");
    const lines = text.split("\n");
    const partLine = lines.find((l) => l.includes(`${pool.name} (EUR)`));
    expect(partLine).toBeDefined();
    expect(partLine).toContain("EUR");
    expect(partLine).toContain("-8,00 EUR");
    const poolLine = lines.find((l) => l.includes(pool.name) && !l.includes("(EUR)"));
    expect(poolLine).toContain("-12,00 PLN");
    expect(text).not.toContain("-20,00");
  } finally {
    await host.stop();
  }
});
