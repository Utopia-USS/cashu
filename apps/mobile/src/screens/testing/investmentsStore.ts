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
import { LOCAL_ONLY } from "../../services/testing/localOnly";
import { memoryAuthenticator } from "../../shell/testing/auth";

/** The kit's calendar day (a Thursday; the review is due on Sunday the 15th). */
export const INVESTMENTS_TODAY: IsoDate = "2026-11-12";
export const INVESTMENTS_VAULT = "1a000000000000000000000000000c01";
/** The second profile of `otherProfile: true`: a household with no data at all. */
export const INVESTMENTS_OTHER_VAULT = "2b000000000000000000000000000c03";
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
  /** A second, empty profile on the phone (`INVESTMENTS_OTHER_VAULT`), for profile-switch tests. */
  readonly otherProfile?: boolean;
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

/**
 * The built vault and price cache of one `content` + `today`, as database images: built once per test file
 * (jest gives each file its own module registry) and copied into every kit, with the clock, HLC and id
 * seed where the build left them, so a copy behaves exactly like a fresh build.
 */
type HlcState = HybridClock["state"];

interface Template {
  readonly vault: Buffer;
  readonly prices: Buffer;
  readonly hlc: HlcState;
  readonly seed: number;
}
const templates = new Map<string, Template>();

function openVault(db: Database.Database, vault = INVESTMENTS_VAULT): Store {
  return Store.open({
    driver: betterSqlite3Driver(db),
    vault,
    salt: vaultSalt(Uint8Array.from({ length: 32 }, (_, i) => (i * 3 + 9) & 0xff)),
    modules: builtinModules(),
    companionReads: true,
  });
}

function vaultEnv(clock: { now: () => number }, hlc: HlcState | null, seed: { value: number }) {
  const env: CommandEnv = {
    device: DEVICE,
    clock,
    hlc: new HybridClock(DEVICE, {
      physical: clock,
      ...(hlc === null ? {} : { restore: hlc }),
    }),
    // Test owner only. This is not a production authority provider.
    lease: { isHolder: () => true },
    random: (n) =>
      Uint8Array.from({ length: n }, () => {
        seed.value = (Math.imul(seed.value, 1_664_525) + 1_013_904_223) >>> 0;
        return seed.value >>> 24;
      }),
  };
  return env;
}

function buildTemplate(content: "portfolio" | "strategy" | "none", today: IsoDate): Template {
  const historyStart = historyStartOf(today);
  const db = new Database(":memory:");
  const store = openVault(db);
  let wall = 0;
  const clock = { now: () => wall };
  const seed = { value: 0xc01 };
  const env = vaultEnv(clock, null, seed);
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
  const pricesDb = new Database(":memory:");
  const prices = new SqlPriceCache(betterSqlite3Driver(pricesDb));
  if (content === "portfolio") seedCompanionPrices(prices, today, historyStart);
  // A clean shutdown recorded before the image is taken (the copies open as a reopened vault).
  store.detach();
  const template: Template = {
    vault: db.serialize(),
    prices: pricesDb.serialize(),
    hlc: env.hlc.state,
    seed: seed.value,
  };
  db.close();
  prices.close();
  return template;
}

/** The second profile: a fresh vault with only its profile created (no strategy, no data). */
function openOther(clock: { now: () => number }): VaultHandle {
  const store = openVault(new Database(":memory:"), INVESTMENTS_OTHER_VAULT);
  const env = vaultEnv(clock, null, { value: 0xc03 });
  const writer = storeWriter(store);
  const created = runCommand(
    store,
    writer,
    createProfile,
    {
      slug: "synthetic-household",
      name: "Synthetic household",
      baseCurrency: "PLN",
      modules: ["budget", "investments"],
    },
    env,
  );
  if (!created.ok) throw new Error(`synthetic profile refused: ${created.reason}`);
  return { store, writer, env };
}

export function investmentsStore(options: InvestmentsStoreOptions = {}) {
  const content = options.content ?? "portfolio";
  const today = options.today ?? INVESTMENTS_TODAY;
  const key = `${content}:${today}`;
  const template = templates.get(key) ?? buildTemplate(content, today);
  templates.set(key, template);
  // This kit's own copy: a deserialized database lives in memory, apart from every other copy.
  const store = openVault(new Database(template.vault));
  // Commands the tests run happen this morning, one millisecond apart.
  let wall = at(today, 9, 40);
  const clock = { now: () => wall++ };
  const env = vaultEnv(clock, template.hlc, { value: template.seed });
  const writer = storeWriter(store);
  const apply = <I, R>(command: Command<I, R>, input: unknown): R => {
    const result = runCommand(store, writer, command, input, env);
    if (!result.ok) throw new Error(`synthetic ${command.id} refused: ${result.reason}`);
    return result.value;
  };

  const prices = new SqlPriceCache(betterSqlite3Driver(new Database(template.prices)));
  const device = DeviceStore.open(betterSqlite3Driver(new Database(":memory:")));
  device.run(setCurrentVault, { vault: INVESTMENTS_VAULT });
  if (options.pricesFetchedAt !== undefined)
    device.run(setPricesFetchedAt, { vault: INVESTMENTS_VAULT, at: options.pricesFetchedAt });
  const vault: VaultHandle = { store, writer, env };
  const other = options.otherProfile === true ? openOther(clock) : null;
  const handles = new Map<string, VaultHandle>([[INVESTMENTS_VAULT, vault]]);
  if (other !== null) handles.set(INVESTMENTS_OTHER_VAULT, other);
  const client = createSyncClient(
    { device, vaults: handles },
    {
      lingerMs: 0,
    },
  );
  /** The query sources' moment: this morning 09:40 local (the screens' `now`). */
  const now = new Date(at(today, 9, 40)).toISOString();
  const services: Services = {
    ...LOCAL_ONLY,
    client,
    device,
    moneyQueries: createMoneyQueries(
      { prices, changes: prices },
      phoneInvestmentSources({ prices, now: () => now }),
    ),
    store,
    storeOf: (id) => {
      if (id === INVESTMENTS_VAULT) return store;
      if (other !== null && id === INVESTMENTS_OTHER_VAULT) return other.store;
      throw new Error(`no synthetic store for ${id}`);
    },
    profiles: [
      {
        vault: INVESTMENTS_VAULT,
        slug: "synthetic-investor",
        name: "Synthetic investor",
        modules: ["budget", "investments"],
        role: "owner",
      },
      ...(other === null
        ? []
        : [
            {
              vault: INVESTMENTS_OTHER_VAULT,
              slug: "synthetic-household",
              name: "Synthetic household",
              modules: ["budget", "investments"],
              role: "owner" as const,
            },
          ]),
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
    close: servicesCloser({
      client,
      vaults: other === null ? [store] : [store, other.store],
      prices,
      device,
    }),
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
    /** The second profile's store (`otherProfile: true`), else null. */
    other: other?.store ?? null,
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
