// The app's stable services, built once at startup: the device store and the two companion demo
// vaults' stores (in-process, sync SQLite) behind @cashu/store-react's synchronous client, the
// first-launch fixture build, the device-local price cache, the read-only money queries and the
// crypto self-test. S41 scaffold: the vaults, salts and device id are synthetic; pairing, the real
// keyring and the sync engine's local append arrive with S29.

import { enabledModules, profileIdentity } from "@cashu/store/core/profile";
import { currentVault, setCurrentVault } from "@cashu/store/device";
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
import { appendBenchLog } from "../platform/benchLog";
import { createMobileKeyStore } from "../platform/keystore";
import { nativeLibsodium } from "../platform/sodium";
import {
  openDeviceStore,
  openPriceCache,
  openVaultStore,
  recreateVaultStore,
} from "../platform/sqlite";
import { localToday } from "../screens/screenContext";
import { type CryptoSelfTest, runCryptoSelfTest } from "../selftest/cryptoSelfTest";
import { SCAFFOLD_DEVICE } from "./device";
import { phoneInvestmentSources } from "./investments";
import { createMoneyQueries, type MoneyQueries } from "./moneyQueries";

interface ServicesProfile {
  readonly vault: string;
  readonly slug: string;
  readonly name: string;
  /** Enabled module ids at boot (`enabledModules`): the profile sheet captions the profiles it does not show. */
  readonly modules: readonly string[];
}

export interface Services {
  /** The store client of every screen (`StoreProvider`). */
  readonly client: StoreClient;
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
}

let services: Services | undefined;

const now = () => performance.now();

export function bootServices(): Services {
  if (services) return services;
  const t0 = now();
  const device = openDeviceStore();
  let openMs = now() - t0;
  const today = localToday();
  const firstLoad: CompanionBuild[] = [];
  // A vault without a finished build (first launch, or a build that stopped halfway) is built again
  // into a fresh database: a half-built demo is never kept.
  const opened = (["anna", "home"] as const).map((which) => {
    const spec = COMPANION_VAULTS[which];
    const t = now();
    let store = openVaultStore(spec.vault, spec.salt);
    openMs += now() - t;
    if (!companionVaultComplete(store, which)) {
      const empty =
        (store.read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0) === 0;
      if (!empty) store = recreateVaultStore(store, spec.vault, spec.salt);
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
  const profiles = opened.flatMap(({ spec, store }) => {
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
          },
        ];
  });
  const storeOf = (vault: string): Store => {
    const handle = vaults.get(vault);
    if (handle === undefined) throw new Error(`no store for vault ${vault} on this device`);
    return handle.store;
  };
  const prices = openPriceCache();
  // TRANSITIONAL(S44): a freshly built Anna comes with her demo prices (the phone's own refresh skips
  // the demo vaults, so they stay).
  if (firstLoad.some((b) => b.vault === COMPANION_VAULTS.anna.vault))
    seedCompanionDemoPrices(prices, today);
  const cryptoSelfTest = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
    runCryptoSelfTest({ lib: nativeLibsodium, keyStore: createMobileKeyStore }),
  );
  services = {
    client,
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
  };
  return services;
}
