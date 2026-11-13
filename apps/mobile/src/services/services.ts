// The app's stable services, built once at startup: the device store and the two companion demo
// vaults' stores (in-process, sync SQLite encrypted with the device key) behind @cashu/store-react's
// synchronous client, the first-launch fixture build, the device-local price cache, the read-only money
// queries and the crypto self-test. Rebuilt only by `resetServices` (the phone wipe), which the root
// follows by remounting its tree (`bumpEpoch`). S41 scaffold: the vaults, salts and device id are
// synthetic; pairing, the real keyring and the sync engine's local append arrive with S29.

import type { ProfileRole } from "@cashu/domain/core/notifications";
import { enabledModules, profileIdentity } from "@cashu/store/core/profile";
import {
  currentVault,
  type DeviceStore,
  setAlertMarked,
  setCurrentVault,
  setNotificationPrefs,
} from "@cashu/store/device";
import type { SqlPriceCache } from "@cashu/store/investments/local";
import { HybridClock, type Store, storeWriter } from "@cashu/store/runtime";
import type { StoreClient } from "@cashu/store-react";
import { createSyncClient, type VaultHandle } from "@cashu/store-react/local";
import {
  buildCompanionVault,
  COMPANION_VAULTS,
  type CompanionBuild,
  companionVaultComplete,
  seedCompanionDemoPrices,
} from "../fixture/companionDemo";
import { companionMarkedAlert } from "../fixture/companionInvestments";
import { appendBenchLog, deleteBenchLogs } from "../platform/benchLog";
import { createMobileKeyStore, deleteKeyStoreFiles, deleteKeyStoreKek } from "../platform/keystore";
import { deleteLanguagePin } from "../platform/language";
import { localAuthenticator } from "../platform/localAuth";
import { nativeLibsodium } from "../platform/sodium";
import {
  databaseFiles,
  deleteDatabaseFiles,
  openDeviceStore,
  openPriceCache,
  openVaultStore,
  phoneDbKey,
  recreateVaultStore,
  storageInfo,
} from "../platform/sqlite";
import { openWithKeyRecovery } from "../platform/sqliteKeying";
import { localToday } from "../screens/screenContext";
import { type CryptoSelfTest, runCryptoSelfTest } from "../selftest/cryptoSelfTest";
import type { Authenticator } from "../shell/auth";
import { isDemoVault } from "./demo";
import { SCAFFOLD_DEVICE } from "./device";
import { phoneInvestmentSources } from "./investments";
import { bumpEpoch, servicesCloser, showWiping } from "./lifecycle";
import { createMoneyQueries, type MoneyQueries } from "./moneyQueries";
import { beforeWipeTasks, wipeDevice } from "./wipe";

interface ServicesProfile {
  readonly vault: string;
  readonly slug: string;
  readonly name: string;
  /** Enabled module ids at boot (`enabledModules`): the profile sheet captions the profiles it does not show. */
  readonly modules: readonly string[];
  readonly role: ProfileRole;
}

/** The at-rest encryption of this launch's databases (the debug screen's storage line). */
interface StorageInfo {
  /** SQLCipher's version; null when the files are not encrypted. */
  readonly cipherVersion: string | null;
}

export interface Services {
  /** The store client of every screen (`StoreProvider`). */
  readonly client: StoreClient;
  /** This device's own store (current profile, device settings; never synced). */
  readonly device: DeviceStore;
  /** Vault queries over this device's price cache and the phone's investments sources. */
  readonly moneyQueries: MoneyQueries;
  /** Anna's store (the default vault), for the debug screen's engine-level status and rebuild. */
  readonly store: Store;
  /** The store of one of this device's vaults; throws for a vault the device does not hold. */
  readonly storeOf: (vault: string) => Store;
  /** This device's profiles (one per vault), read at boot. */
  readonly profiles: readonly ServicesProfile[];
  /** This device's market price cache (prices and FX rates; device-local, never synced). */
  readonly prices: SqlPriceCache;
  /** Store open time (ms, every vault), including the integrity check after an unclean session. */
  readonly openMs: number;
  /** The fixture builds of this launch, one per vault built (empty when every vault was reopened). */
  readonly firstLoad: readonly CompanionBuild[];
  /** Runs after the first frame; the crypto panel suspends on it. */
  readonly cryptoSelfTest: Promise<CryptoSelfTest>;
  readonly storage: StorageInfo;
  /** Face ID / Touch ID / passcode for the app lock. */
  readonly auth: Authenticator;
  /**
   * Every vault on this phone is a demo vault: the app lock defaults to off. TRANSITIONAL(S44): a
   * paired phone holds real vaults and the lock defaults to on.
   */
  readonly isDemo: boolean;
  /** Close every database (client, vaults, price cache, device store); a second call does nothing. */
  close(): void;
}

// TRANSITIONAL(S44): the demo's roles; a paired phone learns its role from pairing.
const COMPANION_ROLES: Readonly<Record<"anna" | "home", ProfileRole>> = {
  anna: "owner",
  home: "partner",
};

let services: Services | undefined;

const now = () => performance.now();

/**
 * Database files without the device key cannot be read, so they are deleted before the key is
 * created: the leftovers of an interrupted wipe (which deletes the key first). The plaintext files of a
 * demo install from before encryption land here too, once (TRANSITIONAL(S44): a paired phone creates
 * encrypted files from day one).
 */
function discardFilesWithoutKey(): void {
  if (phoneDbKey.exists()) return;
  const files = databaseFiles().length;
  if (files === 0) return;
  deleteDatabaseFiles();
  appendBenchLog({ kind: "storage_reset", reason: "interrupted_wipe", files });
}

/** The databases of one launch, opened before anything is built. */
interface OpenDatabases {
  readonly device: DeviceStore;
  readonly vaults: Readonly<Record<"anna" | "home", Store>>;
  readonly prices: SqlPriceCache;
  /** Open time of the device store and the vaults (ms). */
  readonly openMs: number;
}

/**
 * Open every database under `key`. On a failure the ones already open are closed again, so a key
 * mismatch can discard every file (`openWithKeyRecovery`).
 */
function openDatabases(key: string): OpenDatabases {
  const open: { close(): void }[] = [];
  const track = <T extends { close(): void }>(db: T): T => {
    open.push(db);
    return db;
  };
  try {
    const t0 = now();
    const device = track(openDeviceStore(key));
    const anna = track(
      openVaultStore(COMPANION_VAULTS.anna.vault, COMPANION_VAULTS.anna.salt, key),
    );
    const home = track(
      openVaultStore(COMPANION_VAULTS.home.vault, COMPANION_VAULTS.home.salt, key),
    );
    const openMs = now() - t0;
    const prices = track(openPriceCache(key));
    return { device, vaults: { anna, home }, prices, openMs };
  } catch (error) {
    for (const db of open.reverse()) {
      try {
        db.close();
      } catch {
        // The open failure is the one to report.
      }
    }
    throw error;
  }
}

export function bootServices(): Services {
  if (services) return services;
  discardFilesWithoutKey();
  const key = phoneDbKey.loadOrCreate();
  // A key that does not open the files (a Keychain item that outlived an app delete, a restore from
  // another phone) is treated like files without a key: every file is discarded and built again.
  // TRANSITIONAL(S44): a paired phone re-pairs and resyncs instead of building the demo.
  const {
    device,
    vaults: openVaults,
    prices,
    openMs,
  } = openWithKeyRecovery(
    () => openDatabases(key),
    () => {
      const files = deleteDatabaseFiles().length;
      appendBenchLog({ kind: "storage_reset", reason: "key_mismatch", files });
    },
  );
  const today = localToday();
  const firstLoad: CompanionBuild[] = [];
  // A vault without a finished build (first launch, or a build that stopped halfway) is built again
  // into a fresh database: a half-built demo is never kept.
  const opened = (["anna", "home"] as const).map((which) => {
    const spec = COMPANION_VAULTS[which];
    let store = openVaults[which];
    if (!companionVaultComplete(store, which)) {
      const empty =
        (store.read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0) === 0;
      if (!empty) store = recreateVaultStore(store, spec.vault, spec.salt, key);
      const build = buildCompanionVault(store, which, today, now);
      firstLoad.push(build);
      appendBenchLog({ kind: "fixture", ...build });
    }
    return { which, spec, store };
  });
  const anna = COMPANION_VAULTS.anna.vault;
  // Unset, or a vault this device no longer holds (the S41 scaffold's demo vault): Anna.
  const current = currentVault.run((sql, ...p) => device.read(sql, ...p), undefined);
  if (current === null || !opened.some(({ spec }) => spec.vault === current)) {
    device.run(setCurrentVault, { vault: anna });
  }
  const clock = { now: () => Date.now() };
  const vaults = new Map<string, VaultHandle>(
    opened.map(({ spec, store }) => [
      spec.vault,
      {
        store,
        // TRANSITIONAL(S43): straight into the store until commands go through the engine's local append.
        writer: storeWriter(store),
        env: {
          device: SCAFFOLD_DEVICE,
          clock,
          // TRANSITIONAL(S43): the HLC state is not persisted until the sync engine owns it; commands run
          // with a fresh clock each launch.
          hlc: new HybridClock(SCAFFOLD_DEVICE, { physical: clock }),
          lease: { isHolder: () => true },
        },
      },
    ]),
  );
  const client = createSyncClient({ device, vaults });
  const profiles = opened.flatMap(({ which, spec, store }) => {
    const read = store.read.bind(store);
    const identity = profileIdentity.run(read, undefined);
    return identity === null
      ? []
      : [
          {
            vault: spec.vault,
            slug: identity.slug,
            name: identity.name,
            modules: enabledModules.run(read, undefined),
            role: COMPANION_ROLES[which],
          },
        ];
  });
  const storeOf = (vault: string): Store => {
    const handle = vaults.get(vault);
    if (handle === undefined) throw new Error(`no store for vault ${vault} on this device`);
    return handle.store;
  };
  // TRANSITIONAL(S44): a freshly built Anna comes with her demo prices (the phone's own refresh skips
  // the demo vaults, so they stay) and follows her CD Projekt alert on this phone ("tell my phone").
  if (firstLoad.some((b) => b.vault === anna)) {
    seedCompanionDemoPrices(prices, today);
    const annaStore = storeOf(anna);
    const alert = companionMarkedAlert(annaStore.read.bind(annaStore), new Date().toISOString());
    if (alert !== null) {
      device.run(setAlertMarked, { vault: anna, alert, marked: true });
      device.run(setNotificationPrefs, { vault: anna, prefs: { alertsFired: true } });
    }
  }
  const cryptoSelfTest = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
    runCryptoSelfTest({ lib: nativeLibsodium, keyStore: createMobileKeyStore }),
  );
  services = {
    client,
    device,
    store: storeOf(anna),
    storeOf,
    profiles,
    prices,
    moneyQueries: createMoneyQueries(
      { prices, changes: prices },
      phoneInvestmentSources({ prices, now: () => new Date().toISOString() }),
    ),
    openMs,
    firstLoad,
    cryptoSelfTest,
    storage: storageInfo(),
    auth: localAuthenticator,
    isDemo: opened.every(({ spec }) => isDemoVault(spec.vault)),
    close: servicesCloser({
      client,
      vaults: opened.map(({ spec }) => storeOf(spec.vault)),
      prices,
      device,
    }),
  };
  return services;
}

/**
 * Close the current services and build them again (the phone wipe). The caller remounts the tree with
 * `bumpEpoch()`; until then nothing may read the old services.
 */
function resetServices(): Services {
  services?.close();
  services = undefined;
  return bootServices();
}

/**
 * "Remove this phone": cancel and dismiss our notifications, delete every database, key and file this
 * app wrote on the phone, then rebuild the services and remount (or show the fatal state when that
 * could not be done safely). Rejects only when the rebuilt app is shown although a step failed; the fatal
 * state is its own report. TRANSITIONAL(S44): the rebuild lands on the companion demo; a paired phone
 * lands on the pairing screen.
 */
export async function wipeThisPhone(): Promise<void> {
  const current = bootServices();
  await wipeDevice({
    showWiping,
    beforeWipe: beforeWipeTasks(),
    deleteSecrets: async () => {
      // The Keychain items, both service "cashu": the database key `cashu.db.key` and the KeyStore's
      // key-encryption key `cashu.keystore.kek`.
      await Promise.all([phoneDbKey.delete(), deleteKeyStoreKek()]);
    },
    // A macrotask, so React has committed the "Removing" state and the UI thread can draw it while the
    // synchronous close and rebuild hold the JS thread.
    nextFrame: () => new Promise((resolve) => setTimeout(resolve, 0)),
    close: () => current.close(),
    // Everything the app writes under <Documents>: `SQLite/` (every `*.db` with its -wal, -shm and
    // -journal sidecars: the vaults, `device.db`, `market.db`), `keys/` (the KeyStore's sealed values),
    // `bench/` (the measurement log) and `language-pin.txt` (the language choice). The rebuild writes
    // the demo's databases (and a bench line) again.
    deleteFiles: () => {
      deleteKeyStoreFiles();
      deleteBenchLogs();
      deleteLanguagePin();
      deleteDatabaseFiles();
    },
    reset: () => void resetServices(),
    remount: bumpEpoch,
  });
}
