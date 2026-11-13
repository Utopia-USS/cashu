// Synthetic real-store test kit for the native investments screens (the tab, the alert sheet, the position
// and note pages, the review deck). One investments vault built by the companion fixture's own builders
// (`companionInvestments.ts`: the strategy, Anna's portfolio over two accounts, the CD Projekt thesis and
// its alert fired by one daily evaluation, Saturday's research notes, two decisions), the same synthetic
// price series in an in-memory device price cache, a device store and the synchronous client. No
// platform SQLite or keychain and no mocked useQuery. Every name, price and amount is invented.
import { addDays, type IsoDate } from "@cashu/domain";
import {
  betterSqlite3Driver,
  builtinModules,
  type Command,
  type CommandEnv,
  createProfile,
  HybridClock,
  runCommand,
  Store,
  storeWriter,
  vaultSalt,
} from "@cashu/store";
import { DeviceStore, setCurrentVault, setPricesFetchedAt } from "@cashu/store/device";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { saveStrategyVersion } from "@cashu/store/investments/strategy";
import { createSyncClient, type VaultHandle } from "@cashu/store-react/local";
import Database from "better-sqlite3";
import {
  companionStrategy,
  planAnnaInvestments,
  seedCompanionPrices,
} from "../../fixture/companionInvestments";
import { phoneInvestmentSources } from "../../services/investments";
import { servicesCloser } from "../../services/lifecycle";
import { createMoneyQueries } from "../../services/moneyQueries";
import type { Services } from "../../services/services";
import { memoryAuthenticator } from "../../shell/testing/auth";

/** The kit's calendar day (a Thursday; the review is due on Sunday the 15th). */
export const INVESTMENTS_TODAY: IsoDate = "2026-11-12";
const INVESTMENTS_VAULT = "1a000000000000000000000000000c01";
const DEVICE = "1d000000000000000000000000000c02";

export interface InvestmentsStoreOptions {
  /**
   * `portfolio` (default): strategy + Anna's whole portfolio, fired alert, research and decisions;
   * `strategy`: the strategy saved, nothing bought (an empty portfolio);
   * `none`: the investments module on, no strategy synced from the Mac yet.
   */
  readonly content?: "portfolio" | "strategy" | "none";
  readonly today?: IsoDate;
  /** The phone's own price fetch time (`pricesFetchedAt` of the vault); unset = never fetched. */
  readonly pricesFetchedAt?: string;
}

/** Local wall time of `iso` at `hour`:`minute` (ms), as the fixture's `at`. */
function at(iso: IsoDate, hour: number, minute = 0): number {
  const d = new Date(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10)),
  );
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

/** The first day of the month 35 months before `today` (the fixture's 36-month history start). */
function historyStartOf(today: IsoDate): IsoDate {
  const d = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - 35, 1));
  return d.toISOString().slice(0, 10);
}

export function investmentsStore(options: InvestmentsStoreOptions = {}) {
  const content = options.content ?? "portfolio";
  const today = options.today ?? INVESTMENTS_TODAY;
  const historyStart = historyStartOf(today);
  const store = Store.open({
    driver: betterSqlite3Driver(new Database(":memory:")),
    vault: INVESTMENTS_VAULT,
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + 9) & 0xff)),
    modules: builtinModules(),
  });
  let wall = 0;
  const clock = { now: () => wall };
  let seed = 0xc01;
  const env: CommandEnv = {
    device: DEVICE,
    clock,
    hlc: new HybridClock(DEVICE, { physical: clock }),
    // Test owner only. This is not a production authority provider.
    lease: { isHolder: () => true },
    random: (n) =>
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

  // The fixture's plan: steps run in time order with the wall clock at each step's time.
  const steps: { at: number; run: () => void }[] = [];
  const step = (time: number, run: () => void) => steps.push({ at: time, run });
  const start = at(addDays(historyStart, -14), 6);
  step(start, () =>
    apply(createProfile, {
      slug: "synthetic-investor",
      name: "Synthetic investor",
      baseCurrency: "PLN",
      modules: ["budget", "investments"],
    }),
  );
  if (content !== "none") {
    const strategy = companionStrategy();
    step(start, () =>
      apply(saveStrategyVersion, { yamlText: strategy.yaml, mdText: strategy.markdown }),
    );
  }
  if (content === "portfolio")
    planAnnaInvestments({
      today,
      historyStart,
      apply,
      step,
      at,
      read: (sql, ...params) => store.read(sql, ...params),
    });
  const ordered = steps.map((s, i) => ({ ...s, i })).sort((a, b) => a.at - b.at || a.i - b.i);
  for (const s of ordered) {
    wall = s.at;
    s.run();
  }
  // Commands the tests run happen this morning, one millisecond apart.
  wall = at(today, 9, 40);
  clock.now = () => wall++;

  const prices = new SqlPriceCache(betterSqlite3Driver(new Database(":memory:")));
  if (content === "portfolio") seedCompanionPrices(prices, today, historyStart);
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  device.run(setCurrentVault, { vault: INVESTMENTS_VAULT });
  if (options.pricesFetchedAt !== undefined)
    device.run(setPricesFetchedAt, { vault: INVESTMENTS_VAULT, at: options.pricesFetchedAt });
  const vault: VaultHandle = { store, writer, env };
  const client = createSyncClient(
    { device, vaults: new Map([[INVESTMENTS_VAULT, vault]]) },
    {
      lingerMs: 0,
    },
  );
  /** The query sources' moment: this morning 09:40 local (the screens' `now`). */
  const now = new Date(at(today, 9, 40)).toISOString();
  const services: Services = {
    client,
    device,
    moneyQueries: createMoneyQueries(
      { prices, changes: prices },
      phoneInvestmentSources({ prices, now: () => now }),
    ),
    store,
    storeOf: (id) => {
      if (id !== INVESTMENTS_VAULT) throw new Error(`no synthetic store for ${id}`);
      return store;
    },
    profiles: [
      {
        vault: INVESTMENTS_VAULT,
        slug: "synthetic-investor",
        name: "Synthetic investor",
        modules: ["budget", "investments"],
        role: "owner",
      },
    ],
    prices,
    openMs: 0,
    firstLoad: [],
    // Unused by investments screens. These tests never claim a crypto self-test ran.
    cryptoSelfTest: Promise.resolve({ checks: [], ok: false, nativeAead: "not_run" }),
    // better-sqlite3 has no SQLCipher: test files are never encrypted.
    storage: { cipherVersion: null },
    // The lock prompts nothing unless a test scripts it; off by default like the demo.
    auth: memoryAuthenticator(),
    isDemo: true,
    close: servicesCloser({ client, vaults: [store], prices, device }),
  };
  /** An instrument's gid by its ticker (the fixture's keys: CDR, VWCE, EDO, DBND, VT, BETA, ETFBM40TR). */
  const instrument = (symbol: string): string => {
    const row = store.read<{ gid: string }>(
      "SELECT gid FROM inv_instruments WHERE symbol = ?",
      symbol,
    )[0];
    if (row === undefined) throw new Error(`no synthetic instrument ${symbol}`);
    return row.gid;
  };
  return {
    today,
    now,
    store,
    vault,
    device,
    client,
    prices,
    services,
    instrument,
    /** Runs a vault command as this device (throws on a refusal). */
    apply,
    close: services.close,
  };
}

export type InvestmentsStore = ReturnType<typeof investmentsStore>;
