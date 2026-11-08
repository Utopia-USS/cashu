// The stores' SQLite on the phone: expo-sqlite's synchronous API behind the store's expo adapter, so
// the store engine runs in-process on the JS thread (cashu-ts-architecture layers.md, "Which process
// runs what"). One database file per vault plus the device store, in the app's private documents
// directory, which iOS keeps under its default data protection (complete until first user
// authentication), the same class as the KeyStore's Keychain item (AFTER_FIRST_UNLOCK) so background
// sync can read both while the phone is locked.

import { DeviceStore } from "@cashu/store/device";
import type { VaultSalt } from "@cashu/store/gid";
import { builtinModules, expoSqliteDriver, Store } from "@cashu/store/runtime";
import { openDatabaseSync } from "expo-sqlite";

/** Open (or create) the store of `vault`. The store sets WAL + synchronous NORMAL itself. */
export function openVaultStore(vault: string, salt: VaultSalt): Store {
  return Store.open({
    driver: expoSqliteDriver(openDatabaseSync(`vault-${vault}.db`)),
    vault,
    salt,
    modules: builtinModules(),
  });
}

/** Open (or create) the device-local store (current profile, device settings; never synced). */
export function openDeviceStore(): DeviceStore {
  return DeviceStore.open(expoSqliteDriver(openDatabaseSync("device.db")));
}
