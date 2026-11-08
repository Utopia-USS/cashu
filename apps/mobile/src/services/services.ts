// The app's stable services, built once at startup: the device store and the demo vault's store
// (in-process, sync SQLite) behind @cashu/store-react's synchronous client, the first-launch fixture
// load, the read-only money queries and the crypto self-test. S41 scaffold: the vault, salt and device id are
// synthetic; pairing, the real keyring and the sync engine's local append arrive with S29.

import { currentVault, setCurrentVault } from "@cashu/store/device";
import { HybridClock, type Store, storeWriter } from "@cashu/store/runtime";
import type { StoreClient } from "@cashu/store-react";
import { createSyncClient } from "@cashu/store-react/local";
import { DEMO_SALT, DEMO_VAULT } from "../fixture/demoLog";
import { type DemoLoad, loadDemo } from "../fixture/loadDemo";
import { appendBenchLog } from "../platform/benchLog";
import { createMobileKeyStore } from "../platform/keystore";
import { nativeLibsodium } from "../platform/sodium";
import { openDeviceStore, openVaultStore } from "../platform/sqlite";
import { type CryptoSelfTest, runCryptoSelfTest } from "../selftest/cryptoSelfTest";
import { createMoneyQueries, type MoneyQueries } from "./moneyQueries";

/** TRANSITIONAL(S44): this device's id until pairing mints the device identity. */
const SCAFFOLD_DEVICE = "d2000000000000000000000000000041";

export interface Services {
  /** The store client of every screen (`StoreProvider`). */
  readonly client: StoreClient;
  /** Vault queries with an explicit price source; this scaffold has last-trade valuation only. */
  readonly moneyQueries: MoneyQueries;
  /** The demo vault's store, for the debug screen's engine-level status and rebuild. */
  readonly store: Store;
  /** Store open time (ms), including the integrity check after an unclean session. */
  readonly openMs: number;
  /** The fixture load of this launch: set on the first launch (empty store), null when reopened. */
  readonly firstLoad: DemoLoad | null;
  /** Runs after the first frame; the crypto panel suspends on it. */
  readonly cryptoSelfTest: Promise<CryptoSelfTest>;
}

let services: Services | undefined;

const now = () => performance.now();

export function bootServices(): Services {
  if (services) return services;
  const t0 = now();
  const device = openDeviceStore();
  const store = openVaultStore(DEMO_VAULT, DEMO_SALT);
  const openMs = now() - t0;
  const empty = (store.read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0) === 0;
  const firstLoad = empty ? loadDemo(store, now) : null;
  if (firstLoad) {
    const { tables: _tables, ...load } = firstLoad;
    appendBenchLog({ kind: "fixture", ...load });
  }
  if (currentVault.run((sql, ...p) => device.read(sql, ...p), undefined) === null) {
    device.run(setCurrentVault, { vault: DEMO_VAULT });
  }
  const clock = { now: () => Date.now() };
  const client = createSyncClient({
    device,
    vaults: new Map([
      [
        DEMO_VAULT,
        {
          store,
          // TRANSITIONAL(S43): straight into the store until commands go through the engine's local append.
          writer: storeWriter(store),
          env: {
            device: SCAFFOLD_DEVICE,
            clock,
            // TRANSITIONAL(S43): the clock state is persisted by the sync engine; no command runs here yet.
            hlc: new HybridClock(SCAFFOLD_DEVICE, { physical: clock }),
            lease: { isHolder: () => true },
          },
        },
      ],
    ]),
  });
  const cryptoSelfTest = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
    runCryptoSelfTest({ lib: nativeLibsodium, keyStore: createMobileKeyStore }),
  );
  services = {
    client,
    store,
    moneyQueries: createMoneyQueries({ prices: null }),
    openMs,
    firstLoad,
    cryptoSelfTest,
  };
  return services;
}
