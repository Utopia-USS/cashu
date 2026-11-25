// A synthetic investments vault on the real store (better-sqlite3, in memory) for the phone's
// investments sources and price refresh tests: one profile, optionally the passive starter strategy,
// a brokerage account and held instruments bought through the real commands. Every value is invented.
import { strategyTemplate } from "@cashu/domain/investments/strategy";
import {
  betterSqlite3Driver,
  builtinModules,
  type Command,
  createProfile,
  HybridClock,
  investmentsCommands,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { saveStrategyVersion } from "@cashu/store/investments/strategy";
import Database from "better-sqlite3";

const TEST_VAULT = "de000000000000000000000000000042";
const DEVICE = "d2000000000000000000000000000078";

export interface TestHolding {
  readonly symbol: string;
  readonly name: string;
  readonly currency: "PLN" | "EUR";
  readonly yahoo: string;
  readonly mic: string;
  readonly quantity: string;
  readonly price: string;
  readonly fxRate?: string;
}

export function investmentStore(options: {
  readonly strategy: boolean;
  readonly holdings: readonly TestHolding[];
  readonly tradeDate: string;
  /** Defaults to the test vault. */
  readonly vault?: string;
}) {
  const db = new Database(":memory:");
  const store = Store.open({
    driver: betterSqlite3Driver(db),
    vault: options.vault ?? TEST_VAULT,
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 5 + 1) & 0xff)),
    modules: builtinModules(),
    companionReads: true, // the phone's store (openVaultStore)
  });
  const clock = { now: () => Date.parse(`${options.tradeDate}T12:00:00Z`) };
  let seed = 42;
  const env = {
    device: DEVICE,
    clock,
    hlc: new HybridClock(DEVICE, { physical: clock }),
    // Test owner only. This is not a production authority provider.
    lease: { isHolder: () => true },
    random: (n: number) =>
      Uint8Array.from({ length: n }, () => {
        seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
        return seed >>> 24;
      }),
  };
  const writer = storeWriter(store);
  const apply = <I, R>(command: Command<I, R>, input: unknown): R => {
    const result = runCommand(store, writer, command, input, env);
    if (!result.ok) throw new Error(`synthetic ${command.id} refused: ${result.reason}`);
    return result.value;
  };
  apply(createProfile, {
    slug: "synthetic",
    name: "Synthetic",
    baseCurrency: "PLN",
    modules: ["budget", "investments"],
  });
  if (options.strategy) {
    const template = strategyTemplate("passive_etf");
    if (template === null) throw new Error("missing passive_etf template");
    apply(saveStrategyVersion, { yamlText: template.yaml, mdText: template.markdown });
  }
  const { account } = apply(investmentsCommands.addBrokerageAccount, {
    name: "Synthetic brokerage",
    broker: "xtb",
  });
  const instruments = new Map<string, string>();
  for (const h of options.holdings) {
    const { gid } = apply(investmentsCommands.createInstrument, {
      name: h.name,
      symbol: h.symbol,
      mic: h.mic,
      assetClass: "etf",
      currency: h.currency,
      tags: ["global_equity"],
      aliases: [{ namespace: "yahoo", value: h.yahoo, guessed: false }],
    });
    apply(investmentsCommands.addToWatchlist, { target: { stored: gid } });
    apply(investmentsCommands.addManualTransaction, {
      account,
      type: "deposit",
      tradeDate: options.tradeDate,
      cashAmount: "10000",
      currency: "PLN",
    });
    apply(investmentsCommands.addManualTransaction, {
      account,
      instrument: gid,
      type: "buy",
      tradeDate: options.tradeDate,
      quantity: h.quantity,
      price: h.price,
      currency: h.currency,
      ...(h.fxRate === undefined ? {} : { cashCurrency: "PLN", fxRate: h.fxRate }),
    });
    instruments.set(h.symbol, gid);
  }
  return { store, instruments, close: () => store.close() };
}
