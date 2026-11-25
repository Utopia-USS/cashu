// A real held instrument and committed local quote prove the mobile factory passes both the price
// cache and its change source to the genuine overview read model. All values are invented.
import { D, parseDateTime } from "@cashu/domain";
import { market } from "@cashu/domain/investments";
import {
  betterSqlite3Driver,
  builtinModules,
  createProfile,
  HybridClock,
  investmentsCommands,
  openAccount,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { watchQuery } from "@cashu/store/query";
import Database from "better-sqlite3";
import { createMoneyQueries } from "./moneyQueries";

it("updates exact mobile net worth from a committed quote without appending a vault event", () => {
  const vaultDb = new Database(":memory:");
  const cacheDb = new Database(":memory:");
  const store = Store.open({
    driver: betterSqlite3Driver(vaultDb),
    vault: "de000000000000000000000000000041",
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff)),
    modules: builtinModules(),
    companionReads: true, // the phone's store (openVaultStore)
  });
  try {
    const device = "d2000000000000000000000000000077";
    const clock = { now: () => Date.UTC(2026, 9, 1, 12) };
    let seed = 7;
    const env = {
      device,
      clock,
      hlc: new HybridClock(device, { physical: clock }),
      lease: { isHolder: () => true },
      random: (n: number) =>
        Uint8Array.from({ length: n }, () => {
          seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
          return seed >>> 24;
        }),
    };
    const writer = storeWriter(store);
    // A synthetic profile with the budget and investments modules.
    const profile = runCommand(
      store,
      writer,
      createProfile,
      { slug: "synthetic", name: "Synthetic", modules: ["budget", "investments"] },
      env,
    );
    if (!profile.ok) throw new Error(`synthetic profile refused: ${profile.reason}`);
    const account = runCommand(
      store,
      writer,
      openAccount,
      { bank: "xtb", name: "Synthetic brokerage", type: "brokerage", currency: "PLN" },
      env,
    );
    if (!account.ok) throw new Error(`synthetic account refused: ${account.reason}`);
    const trade = runCommand(
      store,
      writer,
      investmentsCommands.addManualTransaction,
      {
        account: account.value.account,
        described: {
          name: "Synthetic instrument",
          currency: "PLN",
          assetClass: "equity",
          symbol: "TST.WA",
        },
        type: "buy",
        tradeDate: "2026-09-01",
        quantity: "10",
        price: "12.5",
        grossAmount: "125",
        fee: "0",
        cashAmount: "-125",
      },
      env,
    );
    if (!trade.ok) throw new Error(`synthetic trade refused: ${trade.reason}`);
    if (trade.value.instrument === null) throw new Error("missing held instrument");
    const alias = runCommand(
      store,
      writer,
      investmentsCommands.addInstrumentAliases,
      {
        instrument: trade.value.instrument,
        aliases: [{ namespace: "yahoo", value: "TST.WA", guessed: false }],
      },
      env,
    );
    if (!alias.ok) throw new Error(`synthetic alias refused: ${alias.reason}`);

    const cache = new SqlPriceCache(betterSqlite3Driver(cacheDb));
    const query = createMoneyQueries({ prices: cache, changes: cache }).overview.hero;
    const observed: ReturnType<typeof D>[] = [];
    const stop = watchQuery(
      store,
      query,
      { today: "2026-10-01" },
      {
        onValue: (view) => observed.push(view.facts.net),
        onError: (error) => {
          throw error;
        },
      },
    );
    try {
      expect(observed).toHaveLength(1);
      const before = observed[0];
      if (before === undefined) throw new Error("missing initial net worth");
      const eventsBefore = store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n;
      expect(eventsBefore).toBeGreaterThan(0);
      cache.upsertBars(
        market.marketSymbol("yahoo", "TST.WA"),
        [
          {
            date: "2026-09-30",
            open: null,
            high: null,
            low: null,
            close: D("20"),
            volume: null,
            currency: null,
            fetchedAt: null,
          },
        ],
        parseDateTime("2026-09-30T18:00:00Z"),
      );
      expect(observed).toHaveLength(2);
      const after = observed[1];
      if (after === undefined) throw new Error("missing quoted net worth");
      expect(after.sub(before).compare(D("75"))).toBe(0);
      expect(store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n).toBe(
        eventsBefore,
      );
    } finally {
      stop();
    }
  } finally {
    store.close();
    cacheDb.close();
  }
});
