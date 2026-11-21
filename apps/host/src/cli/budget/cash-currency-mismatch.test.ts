// `cashu cash-add` names the store's `cash_currency_mismatch` refusal in the CLI language: the cash
// pool of the booked currency is kept in another one (a malformed account no command of the app makes),
// so nothing is written and the command exits 1. A pool in its own currency still books (control).
// Synthetic data only.
import { createTranslator } from "@cashu/i18n";
import { openAccount } from "@cashu/store";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "../../host.js";
import { cleanup, tempDir, testHostOptions } from "../../testing/harness.js";
import { cliCommandKey, runCliVaultCommand } from "../commandOutcome.js";
import { type CommandIo, runTree } from "../tree.js";
import { budgetCommands } from "./index.js";

afterEach(cleanup);

function io(lang: "en" | "pl", out: string[], err: string[]): CommandIo {
  return {
    cwd: tempDir(),
    env: { HOME: tempDir(), CASHU_LANG: lang, COLUMNS: "120" },
    tty: { stdin: false, stdout: false, stderr: false, columns: 120 },
    signal: new AbortController().signal,
    t: createTranslator(lang),
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    prompt: async () => null,
    stdin: async function* () {},
  };
}

it("refuses a cash expense on a pool kept in another currency, in English and Polish", async () => {
  const host = await startLocalHost({ ...testHostOptions(tempDir()), launcher: false });
  try {
    const commands = budgetCommands({ stores: host.stores, now: () => Date.now() });
    const vault = [...host.stores.vaults.values()][0];
    if (!vault) throw new Error("synthetic vault missing");
    // the EUR pool's key, opened in PLN
    const opened = await runCliVaultCommand(
      vault,
      openAccount,
      {
        bank: "manual",
        name: "Synthetic pool",
        type: "cash",
        currency: "PLN",
        externalId: "cash:EUR",
      },
      cliCommandKey(),
    );
    expect(opened.kind).toBe("completed");
    const rows = () => vault.store.read("SELECT count(*) AS n FROM transactions");
    const add = [
      "-p",
      "demo",
      "cash-add",
      "5.00",
      "Synthetic snack",
      "dining",
      "--currency",
      "EUR",
    ];

    for (const [lang, text] of [
      [
        "en",
        "The cash wallet for this currency is kept in another currency, so the expense was not saved.\n",
      ],
      [
        "pl",
        "Portfel gotówkowy w tej walucie jest prowadzony w innej walucie, więc wydatku nie zapisano.\n",
      ],
    ] as const) {
      const out: string[] = [];
      const err: string[] = [];
      expect(await runTree(add, io(lang, out, err), commands)).toEqual({ kind: "exit", code: 1 });
      expect(err).toEqual([text]);
      expect(out).toEqual([]);
    }
    expect(rows()).toEqual([{ n: 0 }]);

    // control: the base currency's pool is created in its own currency and books
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await runTree(
        ["-p", "demo", "cash-add", "5.00", "Synthetic snack", "dining"],
        io("en", out, err),
        commands,
      ),
    ).toEqual({ kind: "exit", code: 0 });
    expect(err).toEqual([]);
    expect(rows()).toEqual([{ n: 1 }]);
  } finally {
    await host.stop();
  }
});
