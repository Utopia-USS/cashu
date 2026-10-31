// The app's stable services, built once at startup: the demo vault's store (in-process, sync SQLite),
// the first-launch fixture load, and the crypto self-test. Debug scaffold (S41): the vault and its
// salt are the synthetic demo ones; pairing and the real keyring arrive with S29.
import type { Store } from "@cashu/store";
import { DEMO_SALT, DEMO_VAULT } from "../fixture/demoLog";
import { type DemoLoad, loadDemo } from "../fixture/loadDemo";
import { appendBenchLog } from "../platform/benchLog";
import { createMobileKeyStore } from "../platform/keystore";
import { nativeLibsodium } from "../platform/sodium";
import { openVaultStore } from "../platform/sqlite";
import { type CryptoSelfTest, runCryptoSelfTest } from "../selftest/cryptoSelfTest";

export interface Services {
  readonly store: Store;
  /** Store open time (ms), including the integrity check after an unclean session. */
  readonly openMs: number;
  /** The fixture load of this launch: set on the first launch (empty store), null when reopened. */
  readonly firstLoad: DemoLoad | null;
  /** Runs after the first frame; the debug screen suspends on it. */
  readonly cryptoSelfTest: Promise<CryptoSelfTest>;
}

let services: Services | undefined;

const now = () => performance.now();

export function bootServices(): Services {
  if (services) return services;
  const t0 = now();
  const store = openVaultStore(DEMO_VAULT, DEMO_SALT);
  const openMs = now() - t0;
  const empty = (store.read<{ n: number }>("SELECT COUNT(*) AS n FROM accounts")[0]?.n ?? 0) === 0;
  const firstLoad = empty ? loadDemo(store, now) : null;
  if (firstLoad) {
    const { tables: _tables, ...load } = firstLoad;
    appendBenchLog({ kind: "fixture", ...load });
  }
  const cryptoSelfTest = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() =>
    runCryptoSelfTest({ lib: nativeLibsodium, keyStore: createMobileKeyStore }),
  );
  services = { store, openMs, firstLoad, cryptoSelfTest };
  return services;
}
