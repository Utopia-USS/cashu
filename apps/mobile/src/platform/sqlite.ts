// The stores' SQLite on the phone: expo-sqlite's synchronous API behind the store's expo adapter, so
// the store engine runs in-process on the JS thread (cashu-ts-architecture layers.md, "Which process
// runs what"). One database file per vault plus the device store, in the app's private documents
// directory, which iOS keeps under its default data protection (complete until first user
// authentication), the same class as the KeyStore's Keychain item (AFTER_FIRST_UNLOCK) so background
// sync can read both while the phone is locked. The market price cache is one more device-local file.

import { DeviceStore } from "@cashu/store/device";
import type { VaultSalt } from "@cashu/store/gid";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { builtinModules, expoSqliteDriver, Store } from "@cashu/store/runtime";
import { deleteDatabaseSync, openDatabaseSync } from "expo-sqlite";

const vaultFile = (vault: string) => `vault-${vault}.db`;

/** Open (or create) the store of `vault`. The store sets WAL + synchronous NORMAL itself. */
export function openVaultStore(vault: string, salt: VaultSalt): Store {
  return Store.open({
    driver: expoSqliteDriver(openDatabaseSync(vaultFile(vault))),
    vault,
    salt,
    modules: builtinModules(),
  });
}

/**
 * Close `store` (the store of `vault`), delete its database file with the WAL and SHM sidecars, and
 * open a fresh empty one. TRANSITIONAL(S44): only for a half-built companion demo vault.
 */
export function recreateVaultStore(store: Store, vault: string, salt: VaultSalt): Store {
  store.close();
  deleteDatabaseSync(vaultFile(vault));
  return openVaultStore(vault, salt);
}

/** Open (or create) the device-local store (current profile, device settings; never synced). */
export function openDeviceStore(): DeviceStore {
  return DeviceStore.open(expoSqliteDriver(openDatabaseSync("device.db")));
}

/** Open (or create) this device's market price cache (prices are device-local, never synced). */
export function openPriceCache(): SqlPriceCache {
  return new SqlPriceCache(expoSqliteDriver(openDatabaseSync("market.db")));
}
